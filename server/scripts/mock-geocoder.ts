/**
 * Deterministic geocoder for tests: a small gazetteer shaped like Nominatim jsonv2 results.
 * search(q) returns entries whose name contains the query's first segment (like a text search),
 * ranked by importance. Same-name places exist on purpose (Station Road, Sai Baba Mandir, Shivaji Nagar).
 */
import type { GeoCandidate, Geocoder } from '../src/services/locate.js';
import { containment } from '../src/services/locate.js';

const mumbai = (suburb: string, district = 'Mumbai Suburban') => ({ suburb, city: 'Mumbai', state_district: district, state: 'Maharashtra', country: 'India' });
const box = (lat: number, lng: number, halfM: number): [number, number, number, number] => {
  const d = halfM / 111_000;
  return [lat - d, lat + d, lng - d, lng + d];
};
const poi = (name: string, lat: number, lng: number, suburb: string, category = 'amenity', type = 'place_of_worship', importance = 0.3): GeoCandidate => ({
  lat, lng, name, display_name: `${name}, ${suburb}, Mumbai, Maharashtra, India`, category, type, addresstype: type,
  importance, address: mumbai(suburb), bbox: box(lat, lng, 40),
});
const road = (name: string, lat: number, lng: number, suburb: string): GeoCandidate => ({
  lat, lng, name, display_name: `${name}, ${suburb}, Mumbai, Maharashtra, India`, category: 'highway', type: 'secondary', addresstype: 'road',
  importance: 0.2, address: mumbai(suburb), bbox: box(lat, lng, 400),
});
const area = (name: string, lat: number, lng: number, city = 'Mumbai', district = 'Mumbai Suburban'): GeoCandidate => ({
  lat, lng, name, display_name: `${name}, ${city}, Maharashtra, India`, category: 'place', type: 'suburb', addresstype: 'suburb',
  importance: 0.4, address: { suburb: name, city, state_district: district, state: 'Maharashtra', country: 'India' }, bbox: box(lat, lng, 1500),
});

export const GAZETTEER: GeoCandidate[] = [
  { ...poi('Gateway of India', 18.9220, 72.8347, 'Colaba', 'tourism', 'attraction', 0.7) },
  poi('Tilak Nagar Colony', 19.0662, 72.8943, 'Chembur', 'building', 'residential', 0.2),
  area('Tilak Nagar', 19.1704, 72.9589), // same-ish name in Mulund
  poi('Shri Sai Baba Mandir', 19.0712, 72.8381, 'Khar West'),
  poi('Sai Baba Mandir', 19.0582, 72.8475, 'Bandra East'),
  poi('Sai Baba Mandir', 19.0180, 72.8440, 'Dadar'),
  road('Station Road', 19.0556, 72.8445, 'Bandra West'),
  road('Station Road', 19.0730, 72.8990, 'Chembur'),
  road('Station Road', 19.1640, 72.8480, 'Goregaon'),
  road('Station Road', 19.2280, 72.8560, 'Borivali'),
  { ...area('Sector 5', 19.1175, 73.0034, 'Navi Mumbai', 'Thane'), type: 'neighbourhood', addresstype: 'neighbourhood' },
  { ...area('Sector 5', 19.0330, 73.0180, 'Navi Mumbai', 'Thane'), type: 'neighbourhood', addresstype: 'neighbourhood' },
  area('Shivaji Nagar', 19.0638, 72.9249),
  area('Shivaji Nagar', 19.0105, 72.8180, 'Mumbai', 'Mumbai City'),
  area('Chembur', 19.0620, 72.9000),
  area('Khar West', 19.0703, 72.8376),
  area('Dharavi', 19.0430, 72.8527, 'Mumbai', 'Mumbai City'),
  area('Andheri', 19.1197, 72.8464),
  poi('Phoenix Mills', 18.9947, 72.8252, 'Lower Parel', 'shop', 'mall', 0.5),
  poi('Infiniti Mall', 19.1395, 72.8305, 'Andheri West', 'shop', 'mall', 0.4),
];

export class MockGeocoder implements Geocoder {
  readonly id = 'mock-gazetteer-v1';
  down = false;
  queries: string[] = [];
  async search(query: string): Promise<GeoCandidate[]> {
    this.queries.push(query);
    if (this.down) throw new Error('mock geocoder is down');
    const head = query.split(',')[0];
    return GAZETTEER.filter((g) => containment(head, g.name) >= 0.6)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 8);
  }
}
