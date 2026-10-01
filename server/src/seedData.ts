import { v4 as uuidv4 } from 'uuid';
import type { Queryable } from './db.js';
import { hashPassword } from './auth.js';
import { ESCALATION_THRESHOLD_MIN, type IncidentType } from './constants.js';

export interface DemoCredentials {
  username: string;
  password: string;
  role: string;
}

/** Replaces all data with the Mumbai demo scenario. Returns the demo login accounts. */
export async function seedDemoData(db: Queryable): Promise<DemoCredentials[]> {
  console.log('Clearing existing data...');
  await db.exec(`
    TRUNCATE notification_reads, notifications, incident_reviews, resource_assignments, blocked_roads,
      audit_log, reports, users, incidents, resources CASCADE;
  `);

  // ── Incidents ──────────────────────────────────────────────────────────


  const incidents = [
    {
      id: uuidv4(),
      type: 'fire',
      status: 'active',
      priority: 'critical',
      priority_score: 95,
      title: 'Major fire in Dharavi slum area',
      description: 'Large fire spreading across multiple shanties in Dharavi. Dense settlement area with narrow lanes making access difficult. Children reported trapped in upper floors. Smoke visible from several kilometres away.',
      raw_message: 'Dharavi mein badi aag lagi hai, kai jhuggiyan jal rahi hain, bacche phase hue hain, jaldi madad bhejo!',
      language: 'hi',
      location_lat: 19.0430,
      location_lng: 72.8567,
      location_name: 'Dharavi, Mumbai',
      people_affected: 55,
      injuries: 8,
      has_children: 1,
      has_elderly: 1,
      has_disabled: 0,
      confidence: 0.92,
      corroborating_reports: 4,
      affected_radius_m: 300,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'flood',
      status: 'responding',
      priority: 'high',
      priority_score: 78,
      title: 'Severe waterlogging in Sion-Matunga area',
      description: 'Roads submerged under 3-4 feet of water after heavy rainfall. Multiple vehicles stranded. Water entering ground-floor residences and shops. Storm drains overflowing.',
      raw_message: 'Sion-Matunga road completely flooded, water level rising, cars stuck, people wading through chest-deep water',
      language: 'en',
      location_lat: 19.0400,
      location_lng: 72.8600,
      location_name: 'Sion-Matunga Road, Mumbai',
      people_affected: 120,
      injuries: 2,
      has_children: 0,
      has_elderly: 1,
      has_disabled: 0,
      confidence: 0.88,
      corroborating_reports: 6,
      affected_radius_m: 500,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'building_collapse',
      status: 'active',
      priority: 'critical',
      priority_score: 98,
      title: 'Building collapse near Bhendi Bazaar',
      description: 'Three-storey residential building collapsed in Bhendi Bazaar area. Approximately 30 people feared trapped under rubble. Rescue operations initiated. Adjacent buildings evacuated as precaution.',
      raw_message: 'Bhendi Bazaar ke paas teen manzila imarat gir gayi, 30 log phas gaye hain, ambulance aur rescue team chahiye turant!',
      language: 'hi',
      location_lat: 18.9550,
      location_lng: 72.8310,
      location_name: 'Bhendi Bazaar, Mumbai',
      people_affected: 30,
      injuries: 15,
      has_children: 1,
      has_elderly: 1,
      has_disabled: 1,
      confidence: 0.95,
      corroborating_reports: 3,
      affected_radius_m: 150,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'gas_leak',
      status: 'active',
      priority: 'high',
      priority_score: 82,
      title: 'Industrial gas leak at Chembur',
      description: 'Gas leak detected at chemical storage facility in Chembur industrial zone. Strong pungent smell reported within 1 km radius. Workers evacuated from nearby factories. Risk of explosion if not contained.',
      raw_message: 'Chembur industrial area mein gas leak ho raha hai, bohot tez badbu aa rahi hai, logo ko nikala ja raha hai',
      language: 'hi',
      location_lat: 19.0620,
      location_lng: 72.8970,
      location_name: 'Chembur Industrial Area, Mumbai',
      people_affected: 200,
      injuries: 5,
      has_children: 0,
      has_elderly: 0,
      has_disabled: 0,
      confidence: 0.85,
      corroborating_reports: 2,
      affected_radius_m: 1000,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'road_accident',
      status: 'responding',
      priority: 'medium',
      priority_score: 55,
      title: 'Multi-vehicle accident on Western Express Highway',
      description: 'Three vehicles involved in collision on Western Express Highway near Goregaon. One truck overturned blocking two lanes. Minor injuries reported. Traffic backed up for 2 km.',
      raw_message: 'WEH pe Goregaon ke paas 3 gadiyon ka accident hua, truck palat gaya, traffic ruki hui hai',
      language: 'hi',
      location_lat: 19.1180,
      location_lng: 72.8460,
      location_name: 'Western Express Highway, Goregaon, Mumbai',
      people_affected: 6,
      injuries: 3,
      has_children: 0,
      has_elderly: 0,
      has_disabled: 0,
      confidence: 0.90,
      corroborating_reports: 2,
      affected_radius_m: 200,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'flood',
      status: 'active',
      priority: 'medium',
      priority_score: 60,
      title: 'Andheri subway waterlogged',
      description: 'Andheri subway underpass completely flooded. Water level approximately 5 feet. All vehicular traffic diverted. Pedestrians unable to cross. Local trains delayed.',
      raw_message: 'Andheri subway pura dooba hua hai, koi gadi nahi ja sakti, paani 5 feet hai, trains bhi late ho rahi hain',
      language: 'hi',
      location_lat: 19.1190,
      location_lng: 72.8467,
      location_name: 'Andheri Subway, Mumbai',
      people_affected: 500,
      injuries: 0,
      has_children: 0,
      has_elderly: 0,
      has_disabled: 0,
      confidence: 0.93,
      corroborating_reports: 8,
      affected_radius_m: 400,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'fire',
      status: 'responding',
      priority: 'high',
      priority_score: 80,
      title: 'Chemical warehouse fire in Wadala',
      description: 'Fire broke out at a chemical storage warehouse in Wadala. Toxic fumes being released. Fire brigade on scene but struggling due to chemical nature of fire. Nearby residential areas being evacuated.',
      raw_message: 'Wadala godown mein aag, chemicals hain andar, zeherili gas nikal rahi hai, fire brigade aayi hai par aag bujh nahi rahi',
      language: 'hi',
      location_lat: 19.0170,
      location_lng: 72.8640,
      location_name: 'Wadala Industrial Estate, Mumbai',
      people_affected: 40,
      injuries: 3,
      has_children: 0,
      has_elderly: 1,
      has_disabled: 0,
      confidence: 0.87,
      corroborating_reports: 3,
      affected_radius_m: 600,
      escalation_deadline: null,
      parent_incident_id: null,
    },
    {
      id: uuidv4(),
      type: 'building_collapse',
      status: 'active',
      priority: 'medium',
      priority_score: 58,
      title: 'Building structural damage in Parel',
      description: 'Large cracks observed in a 40-year-old residential building in Parel. Building tilting slightly. BMC structural engineer requested. 12 families asked to evacuate as precaution.',
      raw_message: 'Parel mein purani building mein badi darar aa gayi hai, building thodi jhuk gayi hai, 12 families ko nikala gaya hai',
      language: 'hi',
      location_lat: 19.0050,
      location_lng: 72.8400,
      location_name: 'Lower Parel, Mumbai',
      people_affected: 48,
      injuries: 0,
      has_children: 1,
      has_elderly: 1,
      has_disabled: 0,
      confidence: 0.80,
      corroborating_reports: 2,
      affected_radius_m: 100,
      escalation_deadline: null,
      parent_incident_id: null,
    },
  ];

  // Minutes since each demo incident was reported, so escalation countdowns look realistic.
  const minutesAgo = [30, 75, 12, 22, 35, 50, 40, 6];
  const now = Date.now();
  const incidentCreatedAt = incidents.map((_, i) => new Date(now - (minutesAgo[i] ?? 10) * 60_000));
  const incidentRows = incidents.map((inc) => ({ ...inc, status: 'triage' as string }));

  // ── Resources ──────────────────────────────────────────────────────────


  const resources = [
    // Hospitals
    {
      id: uuidv4(),
      type: 'hospital',
      name: 'KEM Hospital',
      location_lat: 19.0003,
      location_lng: 72.8416,
      location_name: 'KEM Hospital, Parel, Mumbai',
      status: 'available',
      capacity: 500,
      current_load: 410,
      capabilities: JSON.stringify(['trauma', 'burn_unit', 'icu', 'surgery', 'pediatric', 'emergency']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'hospital',
      name: 'Sion Hospital',
      location_lat: 19.0408,
      location_lng: 72.8625,
      location_name: 'Sion Hospital, Sion, Mumbai',
      status: 'available',
      capacity: 400,
      current_load: 340,
      capabilities: JSON.stringify(['trauma', 'icu', 'surgery', 'emergency', 'orthopedic']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'hospital',
      name: 'Nair Hospital',
      location_lat: 18.9885,
      location_lng: 72.8329,
      location_name: 'Nair Hospital, Mumbai Central',
      status: 'available',
      capacity: 350,
      current_load: 290,
      capabilities: JSON.stringify(['trauma', 'icu', 'surgery', 'emergency', 'burn_unit']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'hospital',
      name: 'Lilavati Hospital',
      location_lat: 19.0509,
      location_lng: 72.8283,
      location_name: 'Lilavati Hospital, Bandra, Mumbai',
      status: 'available',
      capacity: 300,
      current_load: 180,
      capabilities: JSON.stringify(['trauma', 'icu', 'surgery', 'cardiac', 'emergency', 'neurology']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'hospital',
      name: 'Hinduja Hospital',
      location_lat: 19.0382,
      location_lng: 72.8374,
      location_name: 'Hinduja Hospital, Mahim, Mumbai',
      status: 'available',
      capacity: 350,
      current_load: 245,
      capabilities: JSON.stringify(['trauma', 'icu', 'surgery', 'emergency', 'pediatric', 'oncology']),
      assigned_incident_id: null,
      eta_minutes: null,
    },

    // Fire stations
    {
      id: uuidv4(),
      type: 'fire_truck',
      name: 'Byculla Fire Station',
      location_lat: 18.9787,
      location_lng: 72.8334,
      location_name: 'Byculla Fire Station, Mumbai',
      status: 'available',
      capacity: 3,
      current_load: 1,
      capabilities: JSON.stringify(['fire_suppression', 'hazmat', 'rescue', 'ladder']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'fire_truck',
      name: 'Dadar Fire Station',
      location_lat: 19.0178,
      location_lng: 72.8478,
      location_name: 'Dadar Fire Station, Mumbai',
      status: 'dispatched',
      capacity: 3,
      current_load: 2,
      capabilities: JSON.stringify(['fire_suppression', 'rescue', 'ladder', 'water_tanker']),
      assigned_incident_id: incidents[0].id,
      eta_minutes: 12,
    },
    {
      id: uuidv4(),
      type: 'fire_truck',
      name: 'Parel Fire Station',
      location_lat: 19.0045,
      location_lng: 72.8395,
      location_name: 'Parel Fire Station, Mumbai',
      status: 'available',
      capacity: 3,
      current_load: 0,
      capabilities: JSON.stringify(['fire_suppression', 'rescue', 'hazmat', 'chemical_fire']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'fire_truck',
      name: 'Andheri Fire Station',
      location_lat: 19.1198,
      location_lng: 72.8464,
      location_name: 'Andheri Fire Station, Mumbai',
      status: 'available',
      capacity: 3,
      current_load: 0,
      capabilities: JSON.stringify(['fire_suppression', 'rescue', 'ladder']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'fire_truck',
      name: 'Borivali Fire Station',
      location_lat: 19.2288,
      location_lng: 72.8544,
      location_name: 'Borivali Fire Station, Mumbai',
      status: 'available',
      capacity: 3,
      current_load: 0,
      capabilities: JSON.stringify(['fire_suppression', 'rescue', 'water_tanker']),
      assigned_incident_id: null,
      eta_minutes: null,
    },

    // Ambulances
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-101',
      location_lat: 19.0223,
      location_lng: 72.8561,
      location_name: 'Near Dadar TT, Mumbai',
      status: 'dispatched',
      capacity: 2,
      current_load: 1,
      capabilities: JSON.stringify(['basic_life_support', 'oxygen', 'stretcher']),
      assigned_incident_id: incidents[0].id,
      eta_minutes: 8,
    },
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-102',
      location_lat: 18.9650,
      location_lng: 72.8310,
      location_name: 'Near JJ Hospital, Mumbai',
      status: 'available',
      capacity: 2,
      current_load: 0,
      capabilities: JSON.stringify(['advanced_life_support', 'cardiac_monitor', 'ventilator', 'oxygen']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-103',
      location_lat: 19.0750,
      location_lng: 72.8780,
      location_name: 'Near Kurla Station, Mumbai',
      status: 'available',
      capacity: 2,
      current_load: 0,
      capabilities: JSON.stringify(['basic_life_support', 'oxygen', 'stretcher']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-104',
      location_lat: 19.1140,
      location_lng: 72.8690,
      location_name: 'Near Andheri East, Mumbai',
      status: 'en_route',
      capacity: 2,
      current_load: 2,
      capabilities: JSON.stringify(['basic_life_support', 'oxygen', 'stretcher']),
      assigned_incident_id: incidents[4].id,
      eta_minutes: 5,
    },
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-105',
      location_lat: 19.0500,
      location_lng: 72.8900,
      location_name: 'Near Chembur, Mumbai',
      status: 'available',
      capacity: 2,
      current_load: 0,
      capabilities: JSON.stringify(['advanced_life_support', 'cardiac_monitor', 'oxygen', 'pediatric']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'ambulance',
      name: 'Ambulance Unit A-106',
      location_lat: 19.1850,
      location_lng: 72.8490,
      location_name: 'Near Kandivali, Mumbai',
      status: 'available',
      capacity: 2,
      current_load: 0,
      capabilities: JSON.stringify(['basic_life_support', 'oxygen']),
      assigned_incident_id: null,
      eta_minutes: null,
    },

    // Police stations
    {
      id: uuidv4(),
      type: 'police',
      name: 'Dadar Police Station',
      location_lat: 19.0180,
      location_lng: 72.8430,
      location_name: 'Dadar Police Station, Mumbai',
      status: 'available',
      capacity: 10,
      current_load: 3,
      capabilities: JSON.stringify(['crowd_control', 'traffic_management', 'evacuation', 'first_aid']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'police',
      name: 'Bandra Police Station',
      location_lat: 19.0544,
      location_lng: 72.8401,
      location_name: 'Bandra Police Station, Mumbai',
      status: 'available',
      capacity: 10,
      current_load: 2,
      capabilities: JSON.stringify(['crowd_control', 'traffic_management', 'evacuation']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'police',
      name: 'Andheri Police Station',
      location_lat: 19.1195,
      location_lng: 72.8468,
      location_name: 'Andheri Police Station, Mumbai',
      status: 'dispatched',
      capacity: 10,
      current_load: 5,
      capabilities: JSON.stringify(['crowd_control', 'traffic_management', 'evacuation', 'first_aid']),
      assigned_incident_id: incidents[4].id,
      eta_minutes: 3,
    },
    {
      id: uuidv4(),
      type: 'police',
      name: 'Colaba Police Station',
      location_lat: 18.9067,
      location_lng: 72.8147,
      location_name: 'Colaba Police Station, Mumbai',
      status: 'available',
      capacity: 10,
      current_load: 1,
      capabilities: JSON.stringify(['crowd_control', 'traffic_management', 'evacuation']),
      assigned_incident_id: null,
      eta_minutes: null,
    },

    // Shelters
    {
      id: uuidv4(),
      type: 'shelter',
      name: 'Dharavi Community Centre',
      location_lat: 19.0420,
      location_lng: 72.8530,
      location_name: 'Dharavi Community Centre, Mumbai',
      status: 'available',
      capacity: 200,
      current_load: 45,
      capabilities: JSON.stringify(['temporary_housing', 'food_distribution', 'first_aid', 'drinking_water']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'shelter',
      name: 'Sion Municipal School',
      location_lat: 19.0415,
      location_lng: 72.8610,
      location_name: 'BMC School, Sion, Mumbai',
      status: 'available',
      capacity: 150,
      current_load: 0,
      capabilities: JSON.stringify(['temporary_housing', 'food_distribution', 'drinking_water']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'shelter',
      name: 'Andheri Sports Complex',
      location_lat: 19.1200,
      location_lng: 72.8500,
      location_name: 'Andheri Sports Complex, Mumbai',
      status: 'available',
      capacity: 300,
      current_load: 0,
      capabilities: JSON.stringify(['temporary_housing', 'food_distribution', 'medical_camp', 'drinking_water']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'shelter',
      name: 'Worli Community Hall',
      location_lat: 19.0160,
      location_lng: 72.8180,
      location_name: 'Worli Community Hall, Mumbai',
      status: 'available',
      capacity: 120,
      current_load: 0,
      capabilities: JSON.stringify(['temporary_housing', 'food_distribution']),
      assigned_incident_id: null,
      eta_minutes: null,
    },

    // Road crews
    {
      id: uuidv4(),
      type: 'road_crew',
      name: 'BMC Road Crew Alpha',
      location_lat: 19.0300,
      location_lng: 72.8550,
      location_name: 'BMC Ward Office, Matunga, Mumbai',
      status: 'dispatched',
      capacity: 5,
      current_load: 5,
      capabilities: JSON.stringify(['debris_clearing', 'barricading', 'pumping', 'road_repair']),
      assigned_incident_id: incidents[1].id,
      eta_minutes: 0,
    },
    {
      id: uuidv4(),
      type: 'road_crew',
      name: 'BMC Road Crew Beta',
      location_lat: 19.1050,
      location_lng: 72.8620,
      location_name: 'BMC Depot, Kurla, Mumbai',
      status: 'available',
      capacity: 5,
      current_load: 0,
      capabilities: JSON.stringify(['debris_clearing', 'barricading', 'pumping']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
    {
      id: uuidv4(),
      type: 'road_crew',
      name: 'BMC Road Crew Gamma',
      location_lat: 19.1500,
      location_lng: 72.8450,
      location_name: 'BMC Depot, Jogeshwari, Mumbai',
      status: 'available',
      capacity: 5,
      current_load: 0,
      capabilities: JSON.stringify(['debris_clearing', 'barricading', 'road_repair', 'tree_removal']),
      assigned_incident_id: null,
      eta_minutes: null,
    },
  ];


  // ── Blocked Roads ──────────────────────────────────────────────────────


  const blockedRoads = [
    {
      id: uuidv4(),
      incident_id: incidents[1].id,
      start_lat: 19.0380,
      start_lng: 72.8580,
      end_lat: 19.0420,
      end_lng: 72.8620,
      road_name: 'Sion-Matunga Link Road',
      reason: 'Severe waterlogging, 3-4 feet of standing water',
    },
    {
      id: uuidv4(),
      incident_id: incidents[2].id,
      start_lat: 18.9540,
      start_lng: 72.8300,
      end_lat: 18.9560,
      end_lng: 72.8320,
      road_name: 'Bhendi Bazaar Main Road',
      reason: 'Building collapse debris blocking road, rescue operations in progress',
    },
    {
      id: uuidv4(),
      incident_id: incidents[5].id,
      start_lat: 19.1180,
      start_lng: 72.8455,
      end_lat: 19.1200,
      end_lng: 72.8480,
      road_name: 'Andheri Subway Underpass',
      reason: 'Complete waterlogging, 5 feet water level',
    },
    {
      id: uuidv4(),
      incident_id: incidents[4].id,
      start_lat: 19.1170,
      start_lng: 72.8450,
      end_lat: 19.1195,
      end_lng: 72.8470,
      road_name: 'Western Express Highway (Goregaon stretch)',
      reason: 'Multi-vehicle accident, truck overturned blocking two lanes',
    },
  ];


  // ── Resource Assignments ───────────────────────────────────────────────


  // Dadar Fire Station dispatched to Dharavi fire
  const dadarFireStation = resources[6]; // Dadar Fire Station
  const ambulanceA101 = resources[10]; // Ambulance A-101
  const andheriPolice = resources[18]; // Andheri Police
  const ambulanceA104 = resources[13]; // Ambulance A-104
  const roadCrewAlpha = resources[24]; // BMC Road Crew Alpha

  const assignments = [
    {
      id: uuidv4(),
      incident_id: incidents[0].id,
      resource_id: dadarFireStation.id,
      status: 'dispatched',
      ai_score: 0.92,
      ai_reasoning: 'Closest fire station with hazmat capability. 12 min ETA. Has ladder truck needed for multi-storey access in dense slum area.',
      coordinator_action: 'approved',
      coordinator_notes: 'Approved immediately - critical situation with trapped children',
    },
    {
      id: uuidv4(),
      incident_id: incidents[0].id,
      resource_id: ambulanceA101.id,
      status: 'dispatched',
      ai_score: 0.88,
      ai_reasoning: 'Nearest available ambulance with basic life support. 8 min ETA. Burn injuries reported, need immediate medical attention.',
      coordinator_action: 'approved',
      coordinator_notes: null,
    },
    {
      id: uuidv4(),
      incident_id: incidents[4].id,
      resource_id: andheriPolice.id,
      status: 'dispatched',
      ai_score: 0.95,
      ai_reasoning: 'Closest police station to accident site. 3 min ETA. Traffic management capability critical for highway accident.',
      coordinator_action: 'approved',
      coordinator_notes: 'Also requested traffic diversion plan',
    },
    {
      id: uuidv4(),
      incident_id: incidents[4].id,
      resource_id: ambulanceA104.id,
      status: 'en_route',
      ai_score: 0.85,
      ai_reasoning: 'Available ambulance in Andheri East area. 5 min ETA. Basic life support for minor injuries at highway accident.',
      coordinator_action: 'approved',
      coordinator_notes: null,
    },
    {
      id: uuidv4(),
      incident_id: incidents[1].id,
      resource_id: roadCrewAlpha.id,
      status: 'arrived',
      ai_score: 0.90,
      ai_reasoning: 'BMC crew with pumping equipment based in Matunga. Already on scene. Pumping capability essential for flood response.',
      coordinator_action: 'approved',
      coordinator_notes: 'Crew already on scene, pumping operations started',
    },
  ];


  // ── Reports ────────────────────────────────────────────────────────────


  const reports = [
    {
      id: uuidv4(),
      incident_id: incidents[0].id,
      raw_message: 'Dharavi mein badi aag lagi hai, kai jhuggiyan jal rahi hain, bacche phase hue hain, jaldi madad bhejo!',
      language: 'hi',
      source: 'whatsapp',
      reporter_name: 'Rajesh Kumar',
      reporter_phone: '+919876543210',
      extracted_data: JSON.stringify({
        type: 'fire',
        title: 'Major fire in Dharavi',
        description: 'Large fire in Dharavi, multiple shanties burning, children trapped',
        location_name: 'Dharavi',
        location_lat: 19.0430,
        location_lng: 72.8567,
        people_affected: 50,
        injuries: 5,
        has_children: true,
        has_elderly: false,
        has_disabled: false,
        priority: 'critical',
        priority_score: 95,
        urgency_indicators: ['children_trapped', 'spreading_fire', 'dense_area'],
        language: 'hi',
        confidence: 0.92,
      }),
      confidence: 0.92,
      is_duplicate: 0,
    },
    {
      id: uuidv4(),
      incident_id: incidents[0].id,
      raw_message: 'Dharavi fire is getting worse, smoke everywhere, can see from Mahim, please send more help',
      language: 'en',
      source: 'twitter',
      reporter_name: 'Anita Sharma',
      reporter_phone: '+919876543211',
      extracted_data: null,
      confidence: 0.85,
      is_duplicate: 0,
    },
    {
      id: uuidv4(),
      incident_id: incidents[2].id,
      raw_message: 'Bhendi Bazaar ke paas teen manzila imarat gir gayi, 30 log phas gaye hain, ambulance aur rescue team chahiye turant!',
      language: 'hi',
      source: 'call',
      reporter_name: 'Mohammed Ali',
      reporter_phone: '+919876543212',
      extracted_data: JSON.stringify({
        type: 'building_collapse',
        title: 'Building collapse at Bhendi Bazaar',
        description: 'Three-storey building collapsed, approximately 30 people trapped',
        location_name: 'Bhendi Bazaar',
        location_lat: 18.9550,
        location_lng: 72.8310,
        people_affected: 30,
        injuries: 15,
        has_children: true,
        has_elderly: true,
        has_disabled: true,
        priority: 'critical',
        priority_score: 98,
        urgency_indicators: ['people_trapped', 'building_collapse', 'multiple_casualties'],
        language: 'hi',
        confidence: 0.95,
      }),
      confidence: 0.95,
      is_duplicate: 0,
    },
    {
      id: uuidv4(),
      incident_id: incidents[1].id,
      raw_message: 'Sion-Matunga road completely flooded, water level rising, cars stuck, people wading through chest-deep water',
      language: 'en',
      source: 'app',
      reporter_name: 'Priya Patel',
      reporter_phone: '+919876543213',
      extracted_data: null,
      confidence: 0.88,
      is_duplicate: 0,
    },
  ];


  // ── Audit Log ──────────────────────────────────────────────────────────


  const auditEntries = [
    {
      id: uuidv4(),
      entity_type: 'incident',
      entity_id: incidents[0].id,
      action: 'created',
      details: JSON.stringify({
        source: 'ai_extraction',
        confidence: 0.92,
        message: 'Incident created from WhatsApp report via AI extraction',
      }),
    },
    {
      id: uuidv4(),
      entity_type: 'resource_assignment',
      entity_id: assignments[0].id,
      action: 'approved',
      details: JSON.stringify({
        resource_name: 'Dadar Fire Station',
        incident_title: 'Major fire in Dharavi slum area',
        coordinator: 'System',
        ai_score: 0.92,
      }),
    },
    {
      id: uuidv4(),
      entity_type: 'incident',
      entity_id: incidents[2].id,
      action: 'created',
      details: JSON.stringify({
        source: 'phone_call',
        confidence: 0.95,
        message: 'Incident created from emergency call, high confidence extraction',
      }),
    },
    {
      id: uuidv4(),
      entity_type: 'incident',
      entity_id: incidents[0].id,
      action: 'corroborated',
      details: JSON.stringify({
        new_report_count: 4,
        message: 'Incident corroborated by 4 independent reports',
        confidence_updated: 0.92,
      }),
    },
    {
      id: uuidv4(),
      entity_type: 'resource',
      entity_id: roadCrewAlpha.id,
      action: 'status_changed',
      details: JSON.stringify({
        from_status: 'dispatched',
        to_status: 'on_scene',
        message: 'BMC Road Crew Alpha arrived at Sion-Matunga flood site',
      }),
    },
  ];

  // ── Derive workflow state from the assignments ─────────────────────────

  const RESOURCE_STATUS_FOR: Record<string, string> = { dispatched: 'dispatched', en_route: 'en_route', arrived: 'on_scene' };
  const resourceState = new Map<string, { status: string; incident: string }>();
  for (const a of assignments) resourceState.set(a.resource_id, { status: RESOURCE_STATUS_FOR[a.status], incident: a.incident_id });
  for (const row of incidentRows) {
    const mine = assignments.filter((a) => a.incident_id === row.id);
    if (mine.some((a) => a.status === 'arrived')) row.status = 'on_scene';
    else if (mine.length > 0) row.status = 'dispatched';
  }

  // ── Write everything ───────────────────────────────────────────────────

  for (const r of resources) {
    const state = resourceState.get(r.id);
    await db.query(
      `INSERT INTO resources (id, type, name, location_lat, location_lng, location_name, status, capacity,
         current_load, capabilities, eta_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        r.id, r.type, r.name, r.location_lat, r.location_lng, r.location_name,
        state?.status ?? 'available',
        r.capacity, r.current_load, r.capabilities ?? '[]', r.eta_minutes,
      ],
    );
  }
  console.log(`  Inserted ${resources.length} resources`);

  for (const [i, inc] of incidentRows.entries()) {
    const created = incidentCreatedAt[i];
    const threshold = ESCALATION_THRESHOLD_MIN[inc.type as IncidentType];
    const waiting = inc.status === 'triage' || inc.status === 'dispatched';
    await db.query(
      `INSERT INTO incidents (id, type, status, priority, priority_score,
         title, description, raw_message, language, location_lat, location_lng, location_name,
         people_affected, injuries, has_children,
         has_elderly, has_disabled, confidence, corroborating_reports, affected_radius_m,
         escalation_deadline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22)`,
      [
        inc.id, inc.type, inc.status, inc.priority, inc.priority_score,
        inc.title, inc.description, inc.raw_message, inc.language, inc.location_lat, inc.location_lng, inc.location_name,
        inc.people_affected, inc.injuries, Boolean(inc.has_children),
        Boolean(inc.has_elderly), Boolean(inc.has_disabled), inc.confidence,
        inc.corroborating_reports, inc.affected_radius_m,
        waiting ? new Date(created.getTime() + threshold * 60_000) : null,
        created,
      ],
    );
  }
  console.log(`  Inserted ${incidentRows.length} incidents`);

  for (const [resourceId, state] of resourceState) {
    await db.query('UPDATE resources SET assigned_incident_id = $1 WHERE id = $2', [state.incident, resourceId]);
  }

  for (const road of blockedRoads) {
    await db.query(
      `INSERT INTO blocked_roads (id, incident_id, start_lat, start_lng, end_lat, end_lng, road_name, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [road.id, road.incident_id, road.start_lat, road.start_lng, road.end_lat, road.end_lng, road.road_name, road.reason],
    );
  }
  console.log(`  Inserted ${blockedRoads.length} blocked roads`);

  for (const a of assignments) {
    await db.query(
      `INSERT INTO resource_assignments (id, incident_id, resource_id, status, ai_score, ai_reasoning,
         coordinator_action, coordinator_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.id, a.incident_id, a.resource_id, a.status, a.ai_score, a.ai_reasoning, a.coordinator_action, a.coordinator_notes],
    );
  }
  console.log(`  Inserted ${assignments.length} resource assignments`);

  for (const r of reports) {
    await db.query(
      `INSERT INTO reports (id, incident_id, raw_message, language, source, reporter_name, reporter_phone,
         extracted_data, confidence, is_duplicate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.id, r.incident_id, r.raw_message, r.language, r.source, r.reporter_name, r.reporter_phone,
        r.extracted_data, r.confidence, Boolean(r.is_duplicate)],
    );
  }
  console.log(`  Inserted ${reports.length} reports`);

  const incidentIds = new Set(incidents.map((i) => i.id));
  const assignmentIncident = new Map(assignments.map((a) => [a.id, a.incident_id]));
  for (const entry of auditEntries) {
    const incidentId = incidentIds.has(entry.entity_id) ? entry.entity_id : assignmentIncident.get(entry.entity_id) ?? null;
    await db.query(
      `INSERT INTO audit_log (id, entity_type, entity_id, incident_id, user_name, action, details)
       VALUES ($1, $2, $3, $4, 'System', $5, $6)`,
      [entry.id, entry.entity_type, entry.entity_id, incidentId, entry.action, entry.details],
    );
  }
  console.log(`  Inserted ${auditEntries.length} audit log entries`);

  // ── Users ──────────────────────────────────────────────────────────────

  const fieldUnit = resources[11]; // Ambulance Unit A-102, available for the field-unit demo
  const demoUsers = [
    { username: 'admin', full_name: 'Control Room Admin', role: 'admin', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345', resource_id: null },
    { username: 'coordinator', full_name: 'Duty Coordinator', role: 'coordinator', password: process.env.SEED_COORDINATOR_PASSWORD || 'Coord@12345', resource_id: null },
    { username: 'field', full_name: 'Field Unit A-102', role: 'field_reporter', password: process.env.SEED_FIELD_PASSWORD || 'Field@12345', resource_id: fieldUnit.id },
  ];
  for (const u of demoUsers) {
    await db.query(
      `INSERT INTO users (id, username, full_name, password_hash, role, resource_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), u.username, u.full_name, await hashPassword(u.password), u.role, u.resource_id],
    );
  }
  console.log(`  Inserted ${demoUsers.length} users`);

  return demoUsers.map(({ username, password, role }) => ({ username, password, role }));
}
