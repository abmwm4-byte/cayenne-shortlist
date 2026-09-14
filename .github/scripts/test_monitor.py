import copy
import unittest

from monitor import apply_snapshot, collect, record_failure, seed, classify, safe_source, Equipment

T0 = '2026-09-14T00:00:00+00:00'
T1 = '2026-09-14T06:00:00+00:00'
T2 = '2026-09-14T12:00:00+00:00'
RULES = {'catalogue': {'abs': {'id': 'abs', 'label': 'ABS', 'category': 'safety', 'aliases': ['ABS']}}, 'parents': {}}


def car(identifier, price=100000, source='AutoScout24'):
    return {'id': identifier, 'source': source, 'price': price, 'title': identifier, 'url': 'https://www.autoscout24.com/offers/' + identifier, 'features': {'abs': [{'kind': 'equipment', 'text': 'ABS'}]}, 'conflicts': [], 'equipment': ['ABS'], 'fetched_at': T0, 'registration': '11/2023', 'mileage': 30000, 'kw': 349}


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.data = {'snapshot': T0, 'cars': [car('as24-a'), car('as24-b', 90000), car('mobile-c', source='mobile.de')], 'counts': {}}
        self.state = seed(self.data, T0)

    def test_seed_is_not_new(self):
        self.assertEqual(self.state['events'], [])
        self.assertTrue(all(row['baseline'] for row in self.state['listings'].values()))
        self.assertEqual(self.state['listings']['mobile-c']['status'], 'snapshot')

    def test_new_once_and_price_history(self):
        incoming = [car('as24-a', 95000), car('as24-b', 90000), car('as24-new', 110000)]
        data, state = apply_snapshot(self.data, self.state, incoming, T1, RULES)
        self.assertEqual(len(data['cars']), 4)
        self.assertEqual(sorted(event['type'] for event in state['events']), ['new', 'price_drop'])
        self.assertEqual([p['price'] for p in state['listings']['as24-a']['price_history']], [100000, 95000])
        _, again = apply_snapshot(data, state, incoming, T2, RULES)
        self.assertEqual(len(again['events']), 2)
        self.assertEqual(len(again['listings']['as24-a']['price_history']), 2)
        self.assertEqual(again['last_counts']['new'], 0)
        self.assertFalse(again['listings']['as24-new']['baseline'])

    def test_missing_requires_two_successful_checks(self):
        data, once = apply_snapshot(self.data, self.state, [car('as24-a')], T1, RULES)
        self.assertEqual(once['listings']['as24-b']['status'], 'active')
        failed = record_failure(once, T2, 'HTTP 403')
        self.assertEqual(failed['listings'], once['listings'])
        self.assertEqual(failed['last_success'], T1)
        data, twice = apply_snapshot(data, failed, [car('as24-a')], T2, RULES)
        self.assertEqual(twice['listings']['as24-b']['status'], 'not_found')
        self.assertEqual(len(data['cars']), 3)
        self.assertEqual(twice['listings']['mobile-c']['status'], 'snapshot')
        _, returned = apply_snapshot(data, twice, [car('as24-a'), car('as24-b', 90000)], T2, RULES)
        self.assertEqual(returned['events'][0]['type'], 'returned')
        self.assertNotIn('sold', str(returned))

    def test_failure_does_not_mutate_baseline(self):
        before = copy.deepcopy(self.state)
        failed = record_failure(self.state, T1, 'blocked')
        self.assertEqual(self.state, before)
        self.assertEqual(failed['events'], [])
        self.assertIsNone(failed['last_success'])

    def test_large_drop_rejected(self):
        data = {'snapshot': T0, 'cars': [car('as24-' + str(i)) for i in range(20)], 'counts': {}}
        with self.assertRaises(ValueError):
            apply_snapshot(data, seed(data, T0), [], T1, RULES)

    def test_no_invented_price_drop_for_missing_price(self):
        data, state = apply_snapshot(self.data, self.state, [car('as24-a', None), car('as24-b', 90000)], T1, RULES)
        self.assertEqual(state['events'], [])
        _, state = apply_snapshot(data, state, [car('as24-a', 95000), car('as24-b', 90000)], T2, RULES)
        self.assertEqual(state['events'], [])
        self.assertEqual(len(state['listings']['as24-a']['price_history']), 3)

    def test_incomplete_search_rejected(self):
        reader = lambda url: {'numberOfResults': 2, 'numberOfPages': 1, 'listings': [{'id': 'one'}]}
        with self.assertRaises(ValueError):
            collect(T1, Equipment(RULES), reader, lambda seconds: None)

    def test_source_host_allowlist(self):
        with self.assertRaises(ValueError):
            safe_source('https://example.com/offers/car')
        with self.assertRaises(ValueError):
            safe_source('http://www.autoscout24.com/offers/car')

    def test_hybrid_and_filter_exclusion(self):
        vehicle = {'make': 'Porsche', 'model': 'Cayenne', 'fuelCategory': {'formatted': 'Gasoline'}, 'firstRegistrationDateRaw': '2023-11-01', 'rawPowerInKw': 349, 'cylinders': 8}
        detail = {'vehicle': vehicle, 'location': {'countryCode': 'DE'}}
        self.assertEqual(classify(detail)[0], 'v8')
        vehicle['fuelCategory']['formatted'] = 'Electric/Gasoline'
        self.assertIsNone(classify(detail))
        vehicle['fuelCategory']['formatted'] = 'Gasoline'
        vehicle['rawPowerInKw'] = 368
        self.assertIsNone(classify(detail))


if __name__ == '__main__':
    unittest.main()
