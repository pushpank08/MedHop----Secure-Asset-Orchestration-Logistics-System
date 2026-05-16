import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix for default marker icons in React-Leaflet
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

const ITEM_CATEGORIES = ["Critical Medicines", "Pathology Samples", "Surgical Equipment", "Blood/Plasma Units", "General Supplies", "Others"];
const MATERIAL_NATURES = ["Standard", "Fragile", "Biohazardous", "Toxic", "Flammable"];
const PACKAGING_TYPES = ["Standard Box", "Cold Chain (2-8°C)", "Deep Freeze (-20°C)", "Lead-Lined Container", "Tamper-Evident Bag"];

type LogisticsStatus = 'REQUESTED' | 'ACCEPTED' | 'PICKED_UP' | 'AT_CHECKPOINT' | 'DELIVERED' | 'RECEIVED_VERIFIED' | 'CANCELLED' | 'EXPIRED' | 'PROCESSING' | 'COMPLETED';

interface TimelineEvent {
    id: string;
    status: string;
    actor: string;
    location: string;
    notes: string;
    timestamp: string;
    recorded_quantity?: number; // Added to capture handshake volume
}

interface LogisticsRequest {
    id: string; item_name: string; pickup_location: string; dropoff_location: string;
    priority: 'NORMAL' | 'EMERGENCY'; status: LogisticsStatus; created_at: string;
    accession_id?: string; temperature_req: string; hazmat_flag: boolean;
    material_nature: string; packaging_type: string; assigned_courier?: string;
    notes?: string; 
    current_location: string;
    mission_start_time: string;
    route_type: 'DIRECT' | 'HUB_RELAY';
    hub_id?: string;
    lab_results?: string;
    quantity: number; // Integrated authorized quantity
}

const getSLADetails = (missionStart: string, priority: string, status: string, routeType: string, itemName: string) => {
    const terminalStates = ['CANCELLED', 'RECEIVED_VERIFIED', 'EXPIRED', 'COMPLETED'];
    
    // Scenario B ends at RECEIVED_VERIFIED. Scenario A ends at final return confirmation.
    const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(itemName);
    if (terminalStates.includes(status) || (!isScenarioA && status === 'RECEIVED_VERIFIED')) {
        return { time: "--:--", color: 'text-slate-300', stability: 'Finalized', remainingMs: 0 };
    }

    const start = new Date(missionStart).getTime();
    const nowUtc = Date.now();
    
    // --- UPDATED SLA LOGIC PER INTENT ---
    let baseLimitMs = 7200000; 
    if (routeType === 'HUB_RELAY' && isScenarioA) {
        baseLimitMs = 14400000;
    }

    const limit = priority === 'EMERGENCY' ? baseLimitMs / 2 : baseLimitMs; 
    
    const remaining = (start + limit) - nowUtc;

    if (remaining <= 0 || status === 'EXPIRED') {
        return { time: "EXPIRED", color: 'text-red-900', stability: 'Inviable', remainingMs: 0 };
    }

    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);

    let stability = 'Stable';
    let color = 'text-green-500';

    if (remaining < 900000) { 
        stability = 'CRITICAL RISK';
        color = 'text-red-600'; 
    } else if (remaining < limit / 2) {
        stability = 'DEGRADING';
        color = 'text-orange-500';
    }

    return { time: `${h}h ${m}m ${s}s`, color, stability, remainingMs: remaining };
};

const RouteMap = ({ origin, destination, hub = null }: any) => {
    const isSameLocation = origin?.name === destination?.name;
    const center: [number, number] = origin ? [origin.lat, origin.lng] : [25.5941, 85.1376]; 

    return (
        <div className="rounded-4xl overflow-hidden border-4 border-white shadow-xl mb-8 leaflet-container" style={{ height: '350px', zIndex: 1 }}>
            <MapContainer center={center} zoom={12} style={{ height: '100%', width: '100%' }} key={`${origin?.name}-${destination?.name}`}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                {origin && (
                    <Marker position={[origin.lat, origin.lng]}>
                        <Popup>Origin: {origin.name}</Popup>
                    </Marker>
                )}
                {!isSameLocation && destination && (
                    <>
                        <Marker position={[destination.lat, destination.lng]}>
                            <Popup>Destination: {destination.name}</Popup>
                        </Marker>
                        {hub ? (
                            <Polyline 
                                positions={[[origin.lat, origin.lng], [hub.lat, hub.lng], [destination.lat, destination.lng]]} 
                                pathOptions={{ color: "#4CAF50", weight: 4, dashArray: "10, 10" }} 
                            />
                        ) : (
                            <Polyline 
                                positions={[[origin.lat, origin.lng], [destination.lat, destination.lng]]} 
                                pathOptions={{ color: "#3b82f6", weight: 4 }} 
                            />
                        )}
                    </>
                )}
                {hub && !isSameLocation && (
                    <Marker position={[hub.lat, hub.lng]}>
                        <Popup>Transit Hub: {hub.name}</Popup>
                    </Marker>
                )}
            </MapContainer>
        </div>
    );
};

export default function CoordinatorDashboard() {
    const [activeTab, setActiveTab] = useState<'NEW' | 'ACTIVE' | 'HISTORY' | 'RESULTS'>('NEW');
    const [requests, setRequests] = useState<LogisticsRequest[]>([]);
    const [locations, setLocations] = useState<any[]>([]);
    const [inventory, setInventory] = useState<any[]>([]); // New inventory state
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [selectedRequestId, setSelectedRequestId] = useState('');
    const [cancelReason, setCancelReason] = useState('');
    const [ticker, setTicker] = useState(0); 
    const [isVerified, setIsVerified] = useState(false);
    const [patientName, setPatientName] = useState('');
    const [verifying, setVerifying] = useState(false);
    
    const [inspectingRequest, setInspectingRequest] = useState<LogisticsRequest | null>(null);
    const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
    const [loadingTimeline, setLoadingTimeline] = useState(false);
    const [alertedTaskIds, setAlertedTaskIds] = useState<string[]>([]);

    const [formData, setFormData] = useState({
        item: '', pickup: '', dropoff: '', priority: 'NORMAL', nature: 'Standard', 
        packaging: 'Standard Box', accessionId: '', tempReq: 'Room Temp', hazmat: false,
        quantity: 20 // Added default volume per discussion
    });

    useEffect(() => {
        if ("Notification" in window && Notification.permission === "default") {
            Notification.requestPermission();
        }
    }, []);

    // NEW: Fetch Live Inventory for Reconciliation View
    const fetchInventory = async () => {
        try {
            const res = await fetch("http://localhost:8000/get-inventory");
            if (res.ok) setInventory(await res.json());
        } catch (err) {
            console.error("Inventory fetch error:", err);
        }
    };

    useEffect(() => {
        fetchInventory();
        const invSync = setInterval(fetchInventory, 5000);
        return () => clearInterval(invSync);
    }, []);

    const triggerTacticalAlert = (task: any, type: 'CRITICAL' | 'NEW_MISSION') => {
        if (alertedTaskIds.includes(task.id)) return;

        const sounds = {
            CRITICAL: 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
            NEW_MISSION: 'https://actions.google.com/sounds/v1/emergency/emergency_siren_short.ogg'
        };

        const audio = new Audio(sounds[type]);

        if (Notification.permission === "granted") {
            new Notification(`MedHop ${type === 'CRITICAL' ? '⚠️ URGENT' : '📥 UPDATE'}`, {
                body: `${task.item_name} | LIS: ${task.accession_id}\nStatus: ${task.status.replace('_', ' ')}`,
            });
            audio.play().catch(e => console.log("Audio blocked"));
        }
        
        setAlertedTaskIds(prev => [...prev, task.id]);
    };

    const fetchData = async () => {
        const userEmail = localStorage.getItem('user_email') || "bhuvesh@medhop.com";
        const res = await fetch(`http://localhost:8000/get-coordinator-requests?email=${userEmail}`);
        const locRes = await fetch("http://localhost:8000/get-locations");
        if (res.ok) {
            const data = await res.json();
            setRequests(data);
            
            data.forEach((req: LogisticsRequest) => {
                const sla = getSLADetails(req.mission_start_time || req.created_at, req.priority, req.status, req.route_type, req.item_name);
                if (typeof sla.remainingMs === 'number' && sla.remainingMs < 900000 && sla.remainingMs > 0 && !['DELIVERED', 'CANCELLED', 'RECEIVED_VERIFIED', 'COMPLETED'].includes(req.status)) {
                    triggerTacticalAlert(req, 'CRITICAL');
                }
            });
        }
        if (locRes.ok) setLocations(await locRes.json());
    };

    useEffect(() => {
        fetchData();
        const apiSync = setInterval(fetchData, 3000); 
        return () => clearInterval(apiSync);
    }, [alertedTaskIds]);

    useEffect(() => {
        const clock = setInterval(() => setTicker(t => t + 1), 1000);
        return () => clearInterval(clock);
    }, []);

    const handleTimeWarp = async (id: string) => {
        const res = await fetch("http://localhost:8000/simulate-sla-risk", {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                request_id: id,
                minutes: 90,
                warp_biological: true 
            })
        });
        if (res.ok) fetchData();
    };

    const openTimeline = async (req: LogisticsRequest) => {
        setTimeline([]); 
        setInspectingRequest(req);
        setLoadingTimeline(true);
        try {
            const res = await fetch(`http://localhost:8000/get-timeline?request_id=${req.id}`);
            if (res.ok) {
                const data = await res.json();
                setTimeline(data.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()));
            }
        } catch (err) {
            console.error("Timeline Error:", err);
        } finally {
            setLoadingTimeline(false);
        }
    };

    const handleLISVerify = async () => {
        if (!formData.accessionId) return;
        setVerifying(true);
        const res = await fetch(`http://localhost:8000/verify-lis?accession_id=${formData.accessionId}`);
        const data = await res.json();
        if (data.valid) { setIsVerified(true); setPatientName(data.patient); }
        else { alert("LIS ID not found"); setIsVerified(false); }
        setVerifying(false);
    };

    const simulateScan = () => {
        setFormData({ ...formData, accessionId: 'ACC-' + Math.floor(100000 + Math.random() * 900000) });
        setIsVerified(false);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isVerified) return;

        const payload = {
            item_category: formData.item,
            pickup_location: formData.pickup,
            dropoff_location: formData.dropoff,
            priority: formData.priority,
            requester_email: localStorage.getItem('user_email') || "bhuvesh@medhop.com",
            accession_id: formData.accessionId,
            temperature_req: formData.tempReq,
            hazmat_flag: formData.hazmat,
            quantity: formData.quantity, // Added volume to dispatch payload
            route_type: needsHub ? 'HUB_RELAY' : 'DIRECT',
            hub_id: needsHub ? hub?.id : null
        };

        const res = await fetch("http://localhost:8000/create-request", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            setFormData({ item: '', pickup: '', dropoff: '', priority: 'NORMAL', nature: 'Standard', packaging: 'Standard Box', accessionId: '', tempReq: 'Room Temp', hazmat: false, quantity: 20 });
            setIsVerified(false); 
            await fetchData(); 
            setActiveTab('ACTIVE'); 
        }
    };

    const confirmCancellation = async () => {
        if (!cancelReason) return alert("Reason is required");
        const targetId = selectedRequestId;
        setRequests(prev => prev.map(r => r.id === targetId ? {...r, status: 'CANCELLED'} : r));
        setShowCancelModal(false);
        
        try {
            const res = await fetch("http://localhost:8000/verify-handoff", {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    request_id: targetId, 
                    new_status: 'CANCELLED', 
                    verifying_email: localStorage.getItem('user_email') || "coordinator@medhop.com", 
                    courier_email: "COORDINATOR", 
                    notes: `ABORTED BY COORDINATOR: ${cancelReason}` 
                }),
            });

            if (res.ok) { 
                setCancelReason(''); 
                await fetchData(); 
                setActiveTab('HISTORY'); 
            } else {
                await fetchData();
            }
        } catch (e) {
            await fetchData();
        }
    };

    const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180; 
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(lon2/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    // --- REFINED FILTERS PER RECENT CONVO ---
    const activeRequests = requests.filter(r => {
        if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(r.status)) return false;
        const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(r.item_name);
        if (isScenarioA && r.status === 'DELIVERED' && !!r.lab_results) return false;
        if (!isScenarioA && r.status === 'RECEIVED_VERIFIED') return false;
        return true; 
    });

    const historyRequests = requests
        .filter(r => {
            if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(r.status)) return true;
            const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(r.item_name);
            if (isScenarioA && r.status === 'DELIVERED' && !!r.lab_results) return true;
          if (!isScenarioA && r.status === 'RECEIVED_VERIFIED') return true;
            return false;
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const resultRegistry = requests
        .filter(r => !!r.lab_results)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const selectedOrigin = locations.find(l => l.name === formData.pickup);
    const selectedDest = locations.find(l => l.name === formData.dropoff);
    const distance = selectedOrigin && selectedDest ? calculateDistance(selectedOrigin.lat, selectedOrigin.lng, selectedDest.lat, selectedDest.lng) : 0;
    const needsHub = distance > 15;
    const hub = locations.find(l => l.location_type === 'HUB');
    const storageRequests = requests.filter(r => r.status === 'AT_CHECKPOINT');

    return (
        <div className="min-h-screen bg-[#f8fafc] flex font-sans">
            <div className="w-72 bg-slate-900 p-6 flex flex-col fixed h-full z-20 shadow-2xl">
                <div className="flex items-center gap-3 mb-10 px-2">
                    <div className="w-8 h-8 bg-[#4CAF50] rounded-lg flex items-center justify-center font-black text-white italic">M</div>
                    <h2 className="font-bold text-white text-xl tracking-tighter">MedHop <span className="text-[#4CAF50]">Ops</span></h2>
                </div>
                <nav className="space-y-2 flex-1">
                    <button onClick={() => setActiveTab('NEW')} className={`w-full text-left p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'NEW' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>Dispatch Console</button>
                    <button onClick={() => setActiveTab('ACTIVE')} className={`w-full flex justify-between items-center p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'ACTIVE' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>
                        <span>Live Monitors</span>
                        {activeRequests.length > 0 && <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${activeTab === 'ACTIVE' ? 'bg-white text-[#4CAF50]' : 'bg-[#4CAF50] text-white'}`}>{activeRequests.length}</span>}
                    </button>
                    <button onClick={() => setActiveTab('RESULTS')} className={`w-full text-left p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'RESULTS' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>Results Registry</button>
                    <button onClick={() => setActiveTab('HISTORY')} className={`w-full text-left p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'HISTORY' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>Chain of Custody</button>
                </nav>
            </div>

            <main className="flex-1 ml-72 flex flex-col">
                <header className="h-20 bg-white border-b flex items-center px-10 sticky top-0 z-1100 justify-between">
                    <h1 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">
                        {activeTab === 'NEW' ? "Authorize Movement" : activeTab === 'ACTIVE' ? "Live Monitors" : activeTab === 'RESULTS' ? "Results Registry" : "Chain of Custody"}
                    </h1>
                    <button 
                        onClick={() => {
                            Notification.requestPermission().then(permission => {
                                if (permission === 'granted') {
                                    new Notification("System Active", { body: "Notifications are now linked to MedHop Go." });
                                }
                            });
                        }}
                        className="bg-red-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg hover:bg-red-700 transition-all active:scale-95"
                    >
                        Force Security Handshake
                    </button>
                </header>
                
                <div className="p-10 max-w-5xl mx-auto w-full">
                    {/* --- RECONCILIATION MONITOR INTEGRATION --- */}
                    {(activeTab === 'ACTIVE' || activeTab === 'HISTORY') && (
                        <div className="mb-10 animate-in fade-in duration-700">
                            {inventory.length === 0 ? (
                                <div className="p-6 bg-slate-50 border-2 border-dashed rounded-4xl text-center">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Inventory Reconciliation Engine: Awaiting Data...</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-6">
                                    {inventory.map((item) => (
                                        <div key={item.id} className="bg-white p-6 rounded-4xl border border-slate-100 shadow-sm flex justify-between items-center group hover:border-blue-200 transition-all">
                                            <div>
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{item.facility_name}</p>
                                                <h4 className="text-lg font-bold text-slate-800">{item.item_name}</h4>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-2xl font-black text-blue-600 group-hover:scale-110 transition-transform">{item.current_stock}</p>
                                                <p className="text-[9px] font-bold text-slate-400 uppercase">On-Hand Stock</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'NEW' && (
                        <section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                            {selectedOrigin && selectedDest && (
                                <>
                                    <div className="mb-6 p-6 rounded-3xl bg-blue-50 border border-blue-100 flex items-center justify-between shadow-sm">
                                        <div>
                                            <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-1">Route Intelligence</p>
                                            <p className="text-sm font-bold text-slate-700">
                                                Total Distance: {distance.toFixed(2)} km 
                                                {needsHub ? " | ⚠️ Long Distance Transfer" : " | ✅ Optimal Direct Path"}
                                            </p>
                                        </div>
                                        <div className={`px-4 py-2 rounded-xl text-white font-black text-[10px] uppercase shadow-sm ${needsHub ? 'bg-orange-500' : 'bg-green-500'}`}>
                                            {needsHub ? "Hub Relay Required" : "Direct Sprint Enabled"}
                                        </div>
                                    </div>
                                    <RouteMap origin={selectedOrigin} destination={selectedDest} hub={needsHub ? hub : null} />
                                </>
                            )}
                            <form onSubmit={handleSubmit} className="bg-white rounded-[3rem] shadow-sm border border-slate-200 overflow-hidden">
                                <div className="p-10 grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <div className="space-y-6">
                                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest border-b pb-2">Logistics Metadata</h3>
                                        <div className="flex flex-col gap-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">SLA Priority</label>
                                            <div className="flex bg-slate-100 p-1 rounded-2xl gap-1">
                                                <button type="button" onClick={() => setFormData({...formData, priority: 'NORMAL'})} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${formData.priority === 'NORMAL' ? 'bg-[#4CAF50] text-white shadow-sm' : 'text-slate-400'}`}>NORMAL</button>
                                                <button type="button" onClick={() => setFormData({...formData, priority: 'EMERGENCY'})} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${formData.priority === 'EMERGENCY' ? 'bg-red-600 text-white shadow-lg' : 'text-slate-400'}`}>EMERGENCY</button>
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Category</label>
                                            <select className="p-4 bg-slate-50 border rounded-2xl w-full text-sm outline-none" value={formData.item} onChange={e => setFormData({...formData, item: e.target.value})} required>
                                                <option value="">Select Category...</option>
                                                {ITEM_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                            </select>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="flex flex-col gap-2">
                                                <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Origin</label>
                                                <select className="p-4 bg-slate-50 border rounded-2xl text-sm" value={formData.pickup} onChange={e => setFormData({...formData, pickup: e.target.value})} required>
                                                    <option value="">Origin...</option>
                                                    {locations.map(loc => <option key={loc.id} value={loc.name}>{loc.name}</option>)}
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-2">
                                                <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Destination</label>
                                                <select className="p-4 bg-slate-50 border rounded-2xl text-sm" value={formData.dropoff} onChange={e => setFormData({...formData, dropoff: e.target.value})} required>
                                                    <option value="">Dest...</option>
                                                    {locations.map(loc => <option key={loc.id} value={loc.name}>{loc.name}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        {/* --- INTEGRATED QUANTITY INPUT --- */}
                                        <div className="flex flex-col gap-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Transfer Volume (Units)</label>
                                            <input 
                                                type="number" 
                                                className="p-4 bg-slate-50 border rounded-2xl w-full text-sm outline-none focus:ring-2 focus:ring-[#4CAF50]" 
                                                value={formData.quantity} 
                                                onChange={e => setFormData({...formData, quantity: parseInt(e.target.value) || 0})}
                                                min="1"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Material Nature</label>
                                            <select className="p-4 bg-slate-50 border rounded-2xl w-full text-sm outline-none" value={formData.nature} onChange={e => setFormData({...formData, nature: e.target.value})}>
                                                {MATERIAL_NATURES.map(n => <option key={n} value={n}>{n}</option>)}
                                            </select>
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Packaging Protocol</label>
                                            <select className="p-4 bg-slate-50 border rounded-2xl w-full text-sm outline-none" value={formData.packaging} onChange={e => setFormData({...formData, packaging: e.target.value})}>
                                                {PACKAGING_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                                            </select>
                                        </div>
                                    </div>
                                    <div className={`space-y-6 p-8 rounded-[2.5rem] border transition-all ${isVerified ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-100'}`}>
                                        <h3 className={`text-xs font-black uppercase tracking-widest ${isVerified ? 'text-green-600' : 'text-blue-600'}`}>Specimen integrity</h3>
                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center px-1">
                                                <label className="text-[10px] font-bold text-slate-500 uppercase">LIS ID</label>
                                                <div className="flex gap-2">
                                                    <button type="button" onClick={simulateScan} className="text-[9px] font-black bg-slate-200 text-slate-600 px-2 py-1 rounded">Simulate</button>
                                                    <button type="button" onClick={handleLISVerify} disabled={verifying} className={`text-[9px] font-black px-3 py-1.5 rounded-lg uppercase ${isVerified ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:scale-105 transition-all'}`}>
                                                        {verifying ? 'Checking...' : isVerified ? 'Verified' : 'Verify LIS'}
                                                    </button>
                                                </div>
                                            </div>
                                            <input type="text" placeholder="ACC-XXXXXX" className="p-4 bg-white border rounded-2xl w-full font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400" value={formData.accessionId} onChange={e => { setFormData({...formData, accessionId: e.target.value}); setIsVerified(false); }} />
                                            {isVerified && <p className="text-[10px] font-bold text-green-600 ml-2 italic">Matched: {patientName}</p>}
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Temperature Requirement</label>
                                            <select className="p-4 bg-white border rounded-2xl w-full text-sm outline-none focus:ring-2 focus:ring-blue-400" value={formData.tempReq} onChange={e => setFormData({...formData, tempReq: e.target.value})}>
                                                <option value="Room Temp">Ambient (Room Temp)</option>
                                                <option value="Refrigerated">Refrigerated (2-8°C)</option>
                                                <option value="Frozen">Frozen (-20°C)</option>
                                            </select>
                                        </div>
                                        <div className="flex items-center gap-4 bg-white/60 p-5 rounded-2xl border border-blue-100 mt-4">
                                            <input type="checkbox" className="w-5 h-5 accent-red-600 cursor-pointer" checked={formData.hazmat} onChange={e => setFormData({...formData, hazmat: e.target.checked})} />
                                            <p className="text-[10px] font-black text-red-600 uppercase">Hazmat Flag (UN3373)</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="p-10 pt-0">
                                    <button type="submit" disabled={!isVerified} className={`w-full py-5 rounded-4xl font-black uppercase transition-all ${isVerified ? 'bg-[#4CAF50] text-white shadow-xl hover:scale-[1.01]' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
                                        Initialize movement
                                    </button>
                                </div>
                            </form>
                        </section>
                    )}

                    {activeTab === 'ACTIVE' && (
                        <div className="space-y-6">
                            {activeRequests.length === 0 ? <div className="py-24 text-center font-bold text-slate-400 bg-white border-2 border-dashed rounded-[3rem]">No active transmissions.</div> : activeRequests.map((req) => {
                                const sla = getSLADetails(req.mission_start_time || req.created_at, req.priority, req.status, req.route_type, req.item_name);
                                return (
                                    <div key={req.id} className={`p-8 rounded-[3rem] border-2 shadow-sm transition-all duration-500 ${sla.stability === 'CRITICAL RISK' ? 'bg-red-50 border-red-600 ring-4 ring-red-100' : 'bg-white border-slate-100'}`}>
                                        <div className="flex justify-between items-start">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-3">
                                                    <span className={`text-[12px] font-black px-4 py-1.5 rounded-lg uppercase ${req.status === 'AT_CHECKPOINT' ? 'bg-orange-500' : 'bg-blue-600'} text-white shadow-sm tracking-wider`}>
                                                        {req.status === 'AT_CHECKPOINT' ? '📍 SECURED AT HUB' : `STATUS: ${req.status.replace('_', ' ')}`}
                                                    </span>
                                                    <span className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase bg-opacity-20 bg-current border border-current ${sla.color}`}>
                                                        Condition: {sla.stability}
                                                    </span>
                                                    <span className="text-[10px] font-black text-slate-400 uppercase bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                                                         📍 {req.current_location?.replace('_', ' ') || 'ORIGIN'}
                                                    </span>
                                                </div>
                                                <h4 className="font-bold text-2xl mb-1 tracking-tight text-slate-800 italic uppercase">{req.item_name}</h4>
                                                <p className="text-xs font-bold text-slate-400 uppercase tracking-tight">
                                                    {req.pickup_location} <span className="text-blue-300 mx-1">→</span> {req.dropoff_location}
                                                </p>

                                                <div className="flex gap-3 mt-5 items-center">
                                                    <span className="px-3 py-1.5 bg-blue-50 text-blue-600 text-[10px] font-black rounded-xl uppercase border border-blue-100">LIS: {req.accession_id}</span>
                                                    <span className="px-3 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black rounded-xl uppercase">Agent: {req.assigned_courier || 'PENDING'}</span>
                                                    <button onClick={() => openTimeline(req)} className="text-blue-600 text-[10px] font-black uppercase border-b-2 border-blue-100">Audit Trail</button>
                                                    <button 
                                                        onClick={() => handleTimeWarp(req.id)}
                                                        className="ml-auto px-4 py-2 bg-slate-900 text-white text-[9px] font-black rounded-xl hover:bg-indigo-600 transition-all uppercase tracking-widest shadow-lg"
                                                    >
                                                        Simulate 90m Delay
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="text-right ml-8">
                                                <p className="text-[10px] font-black text-slate-400 uppercase mb-1 tracking-widest">SLA Biological Clock</p>
                                                <div className={`font-mono text-4xl font-black mb-4 tracking-tighter ${sla.color}`}>{sla.time}</div>
                                                <button onClick={() => { setSelectedRequestId(req.id); setShowCancelModal(true); }} className="px-6 py-2.5 rounded-xl text-[10px] font-black uppercase border-2 border-red-100 text-red-500 hover:bg-red-600 hover:text-white transition-all">Abort</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {storageRequests.length > 0 && (
                                <div className="mt-12 space-y-4 animate-in fade-in duration-700">
                                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest border-b pb-2 flex items-center gap-2">
                                        <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
                                        Stabilization Vault (Resting In-Storage)
                                    </h3>
                                    {storageRequests.map(req => (
                                        <div key={req.id} className="bg-orange-50/50 border border-orange-100 p-6 rounded-[2.5rem] flex justify-between items-center">
                                            <div className="flex items-center gap-4">
                                                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm text-xl border border-orange-100">❄️</div>
                                                <div>
                                                    <h4 className="font-bold text-slate-800 italic uppercase">{req.item_name}</h4>
                                                    <p className="text-[10px] font-black text-orange-600 uppercase tracking-tighter">
                                                        Awaiting Relay Leg 2 | LIS: {req.accession_id}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <span className="px-4 py-2 bg-white border border-orange-200 rounded-xl text-[10px] font-black text-orange-400 uppercase shadow-sm">
                                                    Secured at Central Hub
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'RESULTS' && (
                        <div className="bg-white rounded-[3rem] border shadow-sm overflow-hidden animate-in fade-in duration-500">
                             <table className="w-full text-left border-collapse">
                                <thead className="bg-slate-50 border-b">
                                    <tr>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest">Patient LIS ID</th>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest">Clinical Findings</th>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest text-right">Verification Date</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {resultRegistry.length === 0 ? (
                                        <tr><td colSpan={3} className="py-24 text-center text-slate-300 font-bold uppercase text-xs italic">No clinical results published.</td></tr>
                                    ) : resultRegistry.map((req) => (
                                        <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                                            <td className="p-8">
                                                <span className="font-mono text-blue-600 font-black tracking-tighter bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100">
                                                    {req.accession_id}
                                                </span>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase mt-2">{req.item_name}</p>
                                            </td>
                                            <td className="p-8">
                                                <p className="text-sm font-bold text-slate-700 italic leading-relaxed">
                                                    "{req.lab_results}"
                                                </p>
                                            </td>
                                            <td className="p-8 text-right">
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                                    {new Date(req.created_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
                                                </p>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                             </table>
                        </div>
                    )}

                    {activeTab === 'HISTORY' && (
                        <div className="bg-white rounded-[3rem] border shadow-sm overflow-hidden">
                            <table className="w-full text-left border-collapse">
                                <thead className="bg-slate-50 border-b">
                                    <tr>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest">Clinical Record</th>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest">Logs & Remarks</th>
                                        <th className="p-8 text-[11px] font-black text-slate-400 uppercase tracking-widest text-right">Actions & Outcome</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {historyRequests.map((req) => (
                                        <tr key={req.id} className="border-t hover:bg-slate-50 transition-colors">
                                            <td className="p-8">
                                                <p className="font-bold text-slate-800 text-xl tracking-tight uppercase italic">{req.item_name}</p>
                                                <p className="text-[10px] text-slate-400 uppercase mt-1 font-bold">ID: {req.accession_id} | Agent: {req.assigned_courier || 'N/A'}</p>
                                            </td>
                                            <td className="p-8">
                                                {req.status === 'CANCELLED' ? (
                                                    <div className="bg-red-50 border border-red-100 p-4 rounded-2xl">
                                                        <p className="text-[9px] font-black text-red-500 uppercase mb-1">Termination Reason</p>
                                                        <p className="text-xs font-bold text-red-800 leading-relaxed">
                                                            {req.notes || "No specific reason provided."}
                                                        </p>
                                                    </div>
                                                ) : (req.status === 'RECEIVED_VERIFIED' || req.status === 'DELIVERED' || req.status === 'COMPLETED') ? (
                                                    <div className="bg-green-50 border border-green-100 p-4 rounded-2xl">
                                                        <p className="text-[9px] font-black text-green-500 uppercase mb-1">Verification Note</p>
                                                        <p className="text-xs font-medium text-green-800 italic">
                                                            Mission Successful.
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <p className="text-xs text-slate-400 italic">Log: {req.status}</p>
                                                )}
                                            </td>
                                            <td className="p-8 text-right">
                                                <div className="flex flex-col items-end gap-3">
                                                    <span className={`text-[10px] font-black px-4 py-1.5 rounded-full uppercase border shadow-sm tracking-widest ${['CANCELLED', 'EXPIRED'].includes(req.status) ? 'bg-red-50 text-red-600 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
                                                        {['RECEIVED_VERIFIED', 'DELIVERED', 'COMPLETED'].includes(req.status) ? 'COMPLETED' : req.status.replace('_', ' ')}
                                                    </span>
                                                    <button 
                                                        onClick={() => openTimeline(req)}
                                                        className="text-[9px] font-black uppercase tracking-widest text-blue-600 hover:text-blue-800 transition-colors border-b-2 border-blue-100 hover:border-blue-600 pb-0.5"
                                                    >
                                                        Audit Trail
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </main>
            
            {showCancelModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-6 text-slate-800">
                    <div className="bg-white rounded-[2.5rem] p-10 max-w-md w-full shadow-2xl">
                        <h3 className="text-xl font-black uppercase mb-4 tracking-tighter">Abort Transmission?</h3>
                        <p className="text-[10px] text-slate-400 mb-6 font-bold uppercase tracking-widest italic">Ultimate Authority Override</p>
                        <textarea className="w-full p-4 bg-slate-50 border rounded-2xl text-sm mb-6 outline-none focus:ring-2 focus:ring-red-400" placeholder="Reason for cancellation (required)..." value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                        <div className="flex gap-4">
                            <button onClick={() => setShowCancelModal(false)} className="flex-1 py-4 bg-slate-100 rounded-xl font-bold text-slate-500">Back</button>
                            <button onClick={confirmCancellation} className="flex-1 py-4 bg-red-600 text-white rounded-xl font-bold shadow-lg">Confirm Abort</button>
                        </div>
                    </div>
                </div>
            )}

            {inspectingRequest && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-2000 flex items-center justify-center p-6">
                    <div className="bg-white rounded-[3rem] p-10 max-w-2xl w-full shadow-2xl max-h-[85vh] flex flex-col">
                        <div className="flex justify-between items-center mb-8 border-b pb-6">
                            <div>
                                <h3 className="text-2xl font-black uppercase tracking-tighter text-slate-800 italic">Chain of Custody</h3>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                                    ID: {inspectingRequest.accession_id} | {inspectingRequest.item_name}
                                </p>
                            </div>
                            <button onClick={() => setInspectingRequest(null)} className="w-10 h-10 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all font-bold">✕</button>
                        </div>

                        <div className="flex-1 overflow-y-auto pr-4 space-y-8 relative before:absolute before:inset-0 before:ml-4.75 before:-z-10 before:h-full before:w-0.5 before:bg-slate-100">
                            {loadingTimeline ? (
                                <div className="py-20 text-center text-[10px] font-black uppercase text-slate-400 animate-pulse tracking-widest">Retrieving Audit Logs...</div>
                            ) : timeline.map((event, idx) => (
                                <div key={event.id} className="relative flex items-start gap-6">
                                    <div className={`mt-1 h-10 w-10 shrink-0 rounded-full border-4 border-white shadow-md flex items-center justify-center text-[10px] font-black text-white ${
                                        event.status === 'CANCELLED' ? 'bg-red-500' : 
                                        (event.status === 'RECEIVED_VERIFIED' || event.status === 'COMPLETED') ? 'bg-green-500' : 
                                        event.status === 'AT_CHECKPOINT' ? 'bg-orange-400' : 'bg-blue-600'
                                    }`}>
                                        {idx + 1}
                                    </div>
                                    
                                    <div className="flex-1 bg-slate-50 p-5 rounded-3xl border border-slate-100 shadow-sm">
                                        <div className="flex justify-between items-start mb-2">
                                            <div>
                                                {/* INTEGRATED STATUS MAPPING FOR AT_CHECKPOINT */}
                                                <span className="font-black text-xs uppercase text-slate-800 block">
                                                    {event.status === 'AT_CHECKPOINT' ? 'HUB SECURED' : event.status.replace('_', ' ')}
                                                </span>
                                                <p className="text-[9px] font-bold text-blue-600 uppercase mt-0.5">{event.location}</p>
                                            </div>
                                            <span className="text-[9px] font-black text-white bg-blue-600 px-2 py-1 rounded-lg border-none shadow-sm">
                                                {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        
                                        <div className="bg-white/80 p-3 rounded-2xl border border-white mt-3">
                                            <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-3 mb-3">
                                                  <div>
                                                      <p className="text-[9px] font-black text-slate-400 uppercase mb-1 tracking-widest italic">
                                                          {event.status === 'CANCELLED' ? 'Terminated By' : 'Actor (Agent)'}
                                                      </p>
                                                      <p className={`text-[11px] font-bold truncate ${event.status === 'CANCELLED' ? 'text-red-600' : 'text-slate-700'}`}>
                                                          {event.actor}
                                                      </p>
                                                  </div>
                                                  {(() => {
                                                      const witnessMatch = event.notes.match(/Witness:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
                                                      const witnessEmail = witnessMatch ? witnessMatch[1] : null;

                                                      if (witnessEmail) {
                                                          return (
                                                              <div>
                                                                  {/* INTEGRATED ROLE IDENTIFICATION */}
                                                                  <p className="text-[9px] font-black text-blue-500 uppercase mb-1 tracking-widest">
                                                                      {['PICKED_UP', 'ACCEPTED', 'REQUESTED', 'AT_CHECKPOINT'].includes(event.status) ? 'ORIGIN STAFF' : 
                                                                       ['DELIVERED', 'RECEIVED_VERIFIED', 'COMPLETED'].includes(event.status) ? 'RECEIVER' : 'WITNESS'}
                                                                  </p>
                                                                  <p className="text-[11px] font-bold text-blue-700 truncate">
                                                                      {witnessEmail}
                                                                  </p>
                                                              </div>
                                                          );
                                                      } else {
                                                          return (
                                                              <div>
                                                                  <p className="text-[9px] font-black text-slate-300 uppercase mb-1">HANDSHAKE</p>
                                                                  <p className="text-[11px] font-bold text-slate-400 italic">System Validated</p>
                                                              </div>
                                                          );
                                                      }
                                                  })()}
                                            </div>

                                            {/* --- INTEGRATED MOVEMENT VOLUME DISPLAY --- */}
                                            <div className="flex justify-between items-center bg-blue-50/50 p-2 rounded-xl mb-3">
                                                <p className="text-[9px] font-black text-blue-500 uppercase">Movement Volume</p>
                                                <p className="text-xs font-black text-blue-700">{event.recorded_quantity || inspectingRequest.quantity} Units</p>
                                            </div>

                                            <div>
                                                  <p className="text-[9px] font-black text-slate-400 uppercase mb-1 tracking-widest italic">Operational Data</p>
                                                  <p className={`text-xs italic leading-relaxed ${event.status === 'CANCELLED' ? 'text-red-700 font-medium' : 'text-slate-600'}`}>
                                                      "{event.notes.split(/\. Witness:/i)[0].split(/\. Integrity:/i)[0]}"
                                                  </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        
                        <div className="mt-8 pt-6 border-t flex justify-center">
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">End of Audit Trail</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}