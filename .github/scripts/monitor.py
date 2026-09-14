import copy
import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'https://www.autoscout24.com/lst/porsche/cayenne?fregfrom=2023&fregto=2024&cy=D%2CA%2CB%2CE%2CF%2CI%2CL%2CNL&damaged_listing=exclude&desc=0&powerfrom=348&powerto=353&powertype=hp&sort=price&ustate=N%2CU&atype=C'
COUNTRIES = {'DE', 'AT', 'BE', 'ES', 'FR', 'IT', 'LU', 'NL'}


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(path)


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {'br', 'li', 'p', 'div', 'hr'}:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'li', 'p', 'div', 'ul'}:
            self.parts.append('\n')

    def handle_data(self, value):
        self.parts.append(value)


def plain(value):
    parser = Text()
    parser.feed(value or '')
    return '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())


def fold(value):
    return re.sub(r'\s+', ' ', ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if not unicodedata.combining(c))).strip()


def safe_source(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'www.autoscout24.com':
        raise ValueError('Unexpected source host')
    return url


class SourceRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        safe_source(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def fetch(url):
    safe_source(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-GB,en;q=0.9'})
    with urllib.request.build_opener(SourceRedirect()).open(request, timeout=40) as response:
        source = response.read(12000000).decode('utf-8')
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', source, re.S)
    if not match:
        raise ValueError('Source did not return structured listing data')
    return json.loads(match.group(1))['props']['pageProps']


def classify(detail):
    vehicle = detail.get('vehicle') or {}
    fuel = (vehicle.get('fuelCategory') or {}).get('formatted', '')
    title = vehicle.get('modelVersionInput') or ''
    if fuel != 'Gasoline' or re.search(r'hybrid|electric', title, re.I):
        return None
    registration = vehicle.get('firstRegistrationDateRaw') or ''
    power = vehicle.get('rawPowerInKw')
    damage = vehicle.get('rawData', {}).get('condition', {}).get('damage') or {}
    if registration[:4] not in {'2023', '2024'} or not isinstance(power, (int, float)) or not 348 <= power <= 353:
        return None
    if (detail.get('location') or {}).get('countryCode') not in COUNTRIES or damage.get('isCurrentlyDamaged') is True:
        return None
    if vehicle.get('make') != 'Porsche' or 'Cayenne' not in str(vehicle.get('modelGroup') or vehicle.get('model')):
        return None
    cylinders = vehicle.get('cylinders')
    if cylinders == 8:
        return 'v8', 'Бензин и 8 цилиндров указаны в объявлении'
    if cylinders is not None and vehicle.get('rawDisplacementInCCM') != 3996:
        return None
    return 'needs_check', 'V8 нужно проверить: число цилиндров отсутствует или противоречит объёму 3996 см³'


class Equipment:
    def __init__(self, rules):
        self.rules = rules
        self.aliases = {fold(alias): key for key, item in rules['catalogue'].items() for alias in item['aliases']}
        self.patterns = {key: re.compile(r'(?<!\w)(?:' + '|'.join(re.escape(fold(alias)) for alias in sorted(item['aliases'], key=len, reverse=True)) + r')(?!\w)') for key, item in rules['catalogue'].items()}

    def extract(self, car, vehicle):
        positive, negative, unknown = {}, {}, []

        def add(key, kind, value, denied=False, inherited=None):
            entries = (negative if denied else positive).setdefault(key, [])
            item = {'kind': kind, 'text': value.strip()[:500]}
            if inherited:
                item['via'] = self.rules['catalogue'][inherited]['label']
            if item not in entries and len(entries) < 8:
                entries.append(item)
            if not denied:
                for parent in self.rules['parents'].get(key, []):
                    add(parent, kind, value, inherited=key)

        for value in car['equipment']:
            key = self.aliases.get(fold(value))
            if key:
                add(key, 'equipment', value)
            else:
                unknown.append(value)
        for field, key in [('hasFullServiceHistory', 'service_history'), ('nonSmoking', 'non_smoker')]:
            if vehicle.get(field) is True:
                add(key, 'attribute', field + ': true')
        for value, key in [('Full leather', 'full_leather'), ('Part leather', 'partial_leather')]:
            if vehicle.get('upholstery') == value:
                add(key, 'attribute', 'Upholstery: ' + value)
        if vehicle.get('driveTrain') == '4WD':
            add('awd', 'attribute', 'Drive train: 4WD')
        for kind, content in [('title', car['title']), ('description', car['description'])]:
            for line in content.splitlines():
                value = fold(line)
                for key, pattern in self.patterns.items():
                    match = pattern.search(value)
                    if not match:
                        continue
                    before = re.split(r'[,;.!?]', value[:match.start()])[-1][-65:]
                    after = value[match.end():match.end() + 70]
                    denied = bool(re.search(r'\b(?:ohne|kein(?:e|en|em|er|es)?|without|sans|senza|niet|not equipped|no)\b', before) or re.match(r'\s*(?:ist |is )?(?:nicht vorhanden|not included|not fitted|nicht verbaut)', after))
                    if key in {'rear_entertainment', 'navigation', 'trailer_hitch'} and (re.search(r'\b(?:vorrustung|vorbereitung|preparation|prepared for)\b', before) or re.match(r'[- ]*(?:vorbereitung|vorrustung|preparation)', after)):
                        denied = True
                    if key == 'warranty' and re.search(r'gegen aufpreis|optional|auf wunsch|gegen mehrpreis', value):
                        continue
                    add(key, kind, line[max(0, match.start() - 90):match.end() + 160], denied=denied)
        return positive, negative, sorted(set(positive) & set(negative)), unknown


def normalize(detail, url, timestamp, equipment):
    classification = classify(detail)
    if not classification:
        return None
    vehicle = detail['vehicle']
    price = (detail.get('prices') or {}).get('public') or {}
    amount = price.get('priceRaw')
    if amount is not None and (not isinstance(amount, (int, float)) or amount < 0):
        raise ValueError('Invalid listing price')
    location = detail.get('location') or {}
    damage = vehicle.get('rawData', {}).get('condition', {}).get('damage') or {}
    car = {'id': 'as24-' + str(detail['id']), 'source': 'AutoScout24', 'url': safe_source(url), 'title': 'Porsche Cayenne ' + (vehicle.get('modelVersionInput') or ''), 'price': amount, 'net_price': price.get('netPriceRaw'), 'vat': price.get('vatRate'), 'mileage': vehicle.get('mileageInKmRaw'), 'registration': vehicle.get('firstRegistrationDate'), 'kw': vehicle.get('rawPowerInKw'), 'hp': vehicle.get('rawPowerInHp'), 'cylinders': vehicle.get('cylinders'), 'displacement': vehicle.get('rawDisplacementInCCM'), 'fuel': 'Gasoline', 'engine_check': classification[1], 'status': classification[0], 'body': vehicle.get('bodyType'), 'color': vehicle.get('bodyColor'), 'interior': str(vehicle.get('upholstery') or '') + ', ' + str(vehicle.get('upholsteryColor') or ''), 'owners': vehicle.get('noOfPreviousOwners'), 'country': location.get('countryCode'), 'city': location.get('city'), 'seller': (detail.get('seller') or {}).get('companyName'), 'accident': 'Отремонтированные последствия ДТП' if damage.get('hasRepairedDamages') else ('Без ДТП по заявлению продавца' if damage.get('accidentFree') else 'не указано'), 'description': plain(detail.get('description')), 'equipment': [item.get('id', '') if isinstance(item, dict) else str(item) for items in (vehicle.get('equipment') or {}).values() for item in items], 'images': [image for image in (detail.get('images') or []) if urllib.parse.urlparse(image).scheme == 'https' and urllib.parse.urlparse(image).hostname == 'prod.pictures.autoscout24.net'], 'duplicate_group': None, 'fetched_at': timestamp}
    features, denied, conflicts, unknown = equipment.extract(car, vehicle)
    car.update({'features': features, 'negative_mentions': denied, 'conflicts': conflicts, 'unmapped_equipment': unknown})
    return car


def collect(timestamp, equipment, reader=fetch, pause=time.sleep):
    first = reader(SOURCE)
    total = first['numberOfResults']
    page_count = first['numberOfPages']
    if not isinstance(total, int) or total < 0 or not isinstance(page_count, int) or not 0 <= page_count <= 30:
        raise ValueError('Unexpected search pagination')
    entries = {}
    for page_number in range(1, max(1, page_count) + 1):
        page = first if page_number == 1 else reader(SOURCE + '&page=' + str(page_number))
        if page['numberOfResults'] != total or page['numberOfPages'] != page_count:
            raise ValueError('Search changed during collection; previous snapshot retained')
        for entry in page['listings']:
            entries[entry['id']] = entry
        pause(1)
    if len(entries) < total:
        raise ValueError('Incomplete search result set; previous snapshot retained')
    cars = []
    for index, (listing_id, entry) in enumerate(entries.items(), 1):
        url = safe_source(urllib.parse.urljoin(SOURCE, entry['url']))
        if not urllib.parse.urlparse(url).path.startswith('/offers/'):
            raise ValueError('Unexpected listing path')
        detail = reader(url)['listingDetails']
        if str(detail['id']) != str(listing_id):
            raise ValueError('Listing ID mismatch')
        car = normalize(detail, url, timestamp, equipment)
        if car:
            cars.append(car)
        print(f'Checked {index}/{len(entries)}', flush=True)
        pause(1)
    return cars, total


def seed(dataset, timestamp):
    listings = {}
    for car in dataset['cars']:
        at = car.get('fetched_at') or dataset['snapshot']
        listings[car['id']] = {'first_seen': at, 'last_seen': at, 'status': 'active' if car['source'] == 'AutoScout24' else 'snapshot', 'baseline': True, 'misses': 0, 'price_history': [{'at': at, 'price': car['price']}]}
    return {'schema': 1, 'started_at': timestamp, 'last_attempt': None, 'last_success': None, 'status': 'pending', 'message': 'Автоматическая проверка ещё не выполнялась', 'source': 'AutoScout24', 'search_url': SOURCE, 'interval_hours': 6, 'saved_search': {'name': 'Cayenne V8 · вся текущая выборка', 'description': '2023–2024, бензиновый V8 / проверка V8, 348–353 кВт, DE/AT/BE/ES/FR/IT/LU/NL; без указанных текущих повреждений'}, 'listings': listings, 'events': [], 'runs': []}


def refresh_catalogue(dataset, rules):
    counts = Counter(key for car in dataset['cars'] for key in car['features'])
    structured = Counter(key for car in dataset['cars'] for key, rows in car['features'].items() if any(row['kind'] in {'equipment', 'attribute'} for row in rows))
    common = set(dataset['cars'][0]['features']) if dataset['cars'] else set()
    for car in dataset['cars']:
        common.intersection_update(set(car['features']) - set(car['conflicts']))
    dataset['catalogue'] = [{**item, 'count': counts[key], 'structured_count': structured[key], 'is_base': key in common} for key, item in rules['catalogue'].items() if counts[key]]
    dataset['common_options'] = sorted(common)
    aliases = {fold(alias): key for key, item in rules['catalogue'].items() for alias in item['aliases']}
    dataset['counts']['canonical_list_options'] = len({aliases[fold(value)] for car in dataset['cars'] for value in car['equipment'] if fold(value) in aliases})
    dataset['counts'].update({'listings': len(dataset['cars']), 'options': len(dataset['catalogue']), 'base_options': len(common), 'filter_options': len(dataset['catalogue']) - len(common), 'raw_labels': len({value for car in dataset['cars'] for value in car['equipment']})})
    groups = defaultdict(list)
    for car in dataset['cars']:
        car['duplicate_group'] = None
        key = (car.get('registration'), car.get('mileage'), car.get('kw'))
        if all(value is not None for value in key):
            groups[key].append(car)
    for key, cars in groups.items():
        if len(cars) > 1:
            group = 'D-' + hashlib.sha256(json.dumps(key).encode()).hexdigest()[:8]
            for car in cars:
                car['duplicate_group'] = group


def apply_snapshot(dataset, radar, incoming, timestamp, rules):
    data, state = copy.deepcopy(dataset), copy.deepcopy(radar)
    previous = {car['id']: car for car in data['cars']}
    received = {car['id']: car for car in incoming}
    if len(received) != len(incoming):
        raise ValueError('Duplicate IDs in snapshot')
    active = sum(car['source'] == 'AutoScout24' and state['listings'][car['id']]['status'] == 'active' for car in data['cars'])
    if active >= 10 and len(received) < active * 0.4:
        raise ValueError('Suspiciously small result set; previous snapshot retained')
    events = []
    for listing_id, car in received.items():
        old = previous.get(listing_id)
        track = state['listings'].get(listing_id)
        if not track:
            track = {'first_seen': timestamp, 'last_seen': timestamp, 'baseline': False, 'status': 'active', 'misses': 0, 'price_history': [{'at': timestamp, 'price': car['price']}]}
            state['listings'][listing_id] = track
            events.append({'type': 'new', 'listing_id': listing_id, 'at': timestamp, 'price': car['price']})
        else:
            old_price = track['price_history'][-1]['price']
            if car['price'] != old_price:
                track['price_history'].append({'at': timestamp, 'price': car['price']})
                if isinstance(old_price, (int, float)) and isinstance(car['price'], (int, float)) and old_price != car['price']:
                    event_type = 'price_drop' if car['price'] < old_price else 'price_increase'
                    events.append({'type': event_type, 'listing_id': listing_id, 'at': timestamp, 'old_price': old_price, 'price': car['price']})
                    if event_type == 'price_drop':
                        track['last_price_drop_at'] = timestamp
            if track['status'] == 'not_found':
                events.append({'type': 'returned', 'listing_id': listing_id, 'at': timestamp, 'price': car['price']})
            track.update({'last_seen': timestamp, 'status': 'active', 'misses': 0})
        previous[listing_id] = car
    for listing_id, car in previous.items():
        if car['source'] != 'AutoScout24' or listing_id in received:
            continue
        track = state['listings'][listing_id]
        track['misses'] += 1
        if track['misses'] >= 2 and track['status'] != 'not_found':
            track['status'] = 'not_found'
            events.append({'type': 'not_found', 'listing_id': listing_id, 'at': timestamp})
    data['cars'] = sorted(previous.values(), key=lambda car: (car['price'] if car['price'] is not None else float('inf'), car['id']))
    data['snapshot'] = max(car['fetched_at'] for car in data['cars'])
    refresh_catalogue(data, rules)
    for event in events:
        car = previous[event['listing_id']]
        event.update({'id': hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()[:20], 'title': car['title'], 'url': car['url'], 'possible_duplicate': car['duplicate_group']})
    state['events'] = (events[::-1] + state['events'])[:300]
    state.update({'last_attempt': timestamp, 'last_success': timestamp, 'status': 'ok', 'message': 'Полная проверка AutoScout24 завершена', 'last_counts': {'checked': len(received), 'new': sum(e['type'] == 'new' for e in events), 'price_drops': sum(e['type'] == 'price_drop' for e in events)}})
    state['runs'] = [{'at': timestamp, 'status': 'ok', **state['last_counts']}] + state['runs'][:39]
    return data, state


def record_failure(radar, timestamp, message):
    state = copy.deepcopy(radar)
    state.update({'last_attempt': timestamp, 'status': 'error', 'message': message})
    state['runs'] = [{'at': timestamp, 'status': 'error', 'message': message}] + state['runs'][:39]
    return state


def main():
    timestamp = now()
    dataset = json.loads((ROOT / 'data.json').read_text(encoding='utf-8'))
    radar_path = ROOT / 'radar.json'
    radar = json.loads(radar_path.read_text(encoding='utf-8')) if radar_path.exists() else seed(dataset, timestamp)
    if '--seed' in sys.argv:
        if not radar_path.exists():
            save(radar_path, radar)
        print('Baseline initialized without new-listing events')
        return
    rules = json.loads((Path(__file__).parent / 'equipment_rules.json').read_text(encoding='utf-8'))
    try:
        incoming, total = collect(timestamp, Equipment(rules))
        updated, state = apply_snapshot(dataset, radar, incoming, timestamp, rules)
        state['search_results'] = total
        updated['monitoring'] = {'source': 'AutoScout24', 'last_success': timestamp}
        save(ROOT / 'data.json', updated)
    except urllib.error.HTTPError as error:
        state = record_failure(radar, timestamp, f'AutoScout24: HTTP {error.code}. Последняя успешная выборка сохранена.')
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError) as error:
        state = record_failure(radar, timestamp, f'Проверка не завершена ({type(error).__name__}). Данные и история сохранены.')
        print(f'Source check incomplete: {type(error).__name__}', flush=True)
    save(radar_path, state)
    print(json.dumps({'status': state['status'], 'last_success': state['last_success'], 'counts': state.get('last_counts', {})}, ensure_ascii=False))


if __name__ == '__main__':
    main()
