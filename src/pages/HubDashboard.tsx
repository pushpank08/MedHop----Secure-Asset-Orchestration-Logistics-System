import React, { useState, useEffect } from 'react';

// Unified Statuses
type LogisticsStatus = 'PICKED_UP' | 'AT_CHECKPOINT' | 'DELIVERED' | 'CANCELLED' | 'REQUESTED' | 'ACCEPTED' | 'PROCESSING';

interface HubTask {
  id: string;
  item_name: string;
  accession_id: string;
  status: string;
  pickup_location: string;
  dropoff_location: string;
  temperature_req: string;
  assigned_courier: string;
  notes?: string;
  created_at: string;
  mission_start_time: string;
  current_location: string;
  relay_step: number;
  route_type: 'DIRECT' | 'HUB_RELAY';
  lab_results?: string; 
}

interface StorageLog {
  id: string;
  accession_id: string;
  item_name: string;
  inbound_courier: string;
  outbound_courier?: string;
  storage_slot: string;
  check_in_time: string;
  check_out_time?: string;
  status: 'IN_STORAGE' | 'RELEASED';
}

// Map of storage units categorized by medical compliance types with capacity metadata
const VAULT_STRUCTURE = {
  "Room Temp": { lockers: ["Ambient-Bay 01", "Ambient-Bay 02", "Secure-Locker X", "Secure-Locker Y"], capacity: 2 },
  "Refrigerated": { lockers: ["Cold-Zone A1", "Cold-Zone A2", "Cold-Zone B1"], capacity: 2 },
  "Frozen": { lockers: ["Deep-Freeze 99", "Deep-Freeze 100", "Cryo-Vault 01"], capacity: 2 }
};

// CAPACITY CONFIGURATION
const DRAWER_MAX_CAPACITY = 2; 

export default function HubDashboard() {
  const [tasks, setTasks] = useState<HubTask[]>([]);
  const [logs, setLogs] = useState<StorageLog[]>([]);
  const [activeTab, setActiveTab] = useState<'INBOUND' | 'STORAGE' | 'OUTBOUND' | 'HISTORY'>('INBOUND');
  const [verifyingEmail, setVerifyingEmail] = useState('');
  const [selectedDrawer, setSelectedDrawer] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [searchQuery, setSearchQuery] = useState('');
  const [alertedTaskIds, setAlertedTaskIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'IN_STORAGE'>('IN_STORAGE');

  // Get Hub Manager info from local storage
  const managerEmail = localStorage.getItem('user_email') || "rupak@medhop.com";
  const managerName = localStorage.getItem('user_name') || "Hub Manager";

  // Logic: Updated to count items that are physically in the hub using logs status
  const getDrawerOccupancy = () => {
    const occupancy: Record<string, number> = {};
    logs.forEach(l => {
      if (l.status === 'IN_STORAGE') {
        occupancy[l.storage_slot] = (occupancy[l.storage_slot] || 0) + 1;
      }
    });
    return occupancy;
  };

  const drawerOccupancy = getDrawerOccupancy();

  // Helper to ensure strict thermal compliance during selection
  const getCompliantDrawers = (tempReq: string) => {
    return VAULT_STRUCTURE[tempReq as keyof typeof VAULT_STRUCTURE]?.lockers || [];
  };

  // --- NOTIFICATION PERMISSIONS ---
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // --- TACTICAL ALERT ENGINE ---
  const triggerTacticalAlert = (task: any, type: 'CRITICAL' | 'NEW_MISSION') => {
    if (alertedTaskIds.includes(task.id)) return;

    const sounds = {
      CRITICAL: 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
      NEW_MISSION: 'https://actions.google.com/sounds/v1/emergency/emergency_siren_short.ogg'
    };

    const audio = new Audio(sounds[type]);

    if (Notification.permission === "granted") {
      new Notification(`MEDHOP ${type === 'CRITICAL' ? 'URGENT' : 'INBOUND'}`, {
        body: `${task.item_name} | LIS: ${task.accession_id}\nStatus: ${task.status.replace('_', ' ')}`,
      });
      audio.play().catch(e => console.log("Audio play blocked"));
    }
    
    setAlertedTaskIds(prev => [...prev, task.id]);
  };

  const fetchHubData = async () => {
    try {
      const res = await fetch("http://localhost:8000/get-courier-tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(data);

        // Alert on Inbound Pickups (Scenario A/B Leg 1 and Scenario A Leg 3)
        data.forEach((t: HubTask) => {
           const isLeg1 = t.relay_step === 1 && t.status === 'PICKED_UP';
           const isLeg3 = t.relay_step === 3 && t.status === 'PICKED_UP';
           if (t.route_type === 'HUB_RELAY' && (isLeg1 || isLeg3)) {
              triggerTacticalAlert(t, 'NEW_MISSION');
           }
        });
      }
      
      const logRes = await fetch("http://localhost:8000/get-hub-logs");
      if (logRes.ok) {
        const logData = await logRes.json();
        setLogs(logData);
      }
    } catch (err) {
      console.error("Fetch Error:", err);
    }
  };

  useEffect(() => {
    fetchHubData();
    const interval = setInterval(fetchHubData, 4000);
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => {
        clearInterval(interval);
        clearInterval(ticker);
    };
  }, [alertedTaskIds]);

  const handleStatusUpdate = async (taskId: string, newStatus: string, actionType: 'IN' | 'OUT', courierEmail?: string) => {
    // FIX: actionType 'IN' uses courierEmail (sender). actionType 'OUT' uses verifyingEmail (receiver/Hub Signature).
    const finalPartnerEmail = actionType === 'IN' ? courierEmail : verifyingEmail;

    if (!finalPartnerEmail) {
      alert("Verification Email required for Handshake Protocol");
      return;
    }

    if (actionType === 'IN' && !selectedDrawer) {
      alert("Please select a storage drawer based on specimen requirement");
      return;
    }

    setLoading(true);
    
    // Specifically adds "AT CHECKPOINT" entry notes to prove hub residence time
    const noteContent = actionType === 'IN' 
      ? `AT CHECKPOINT: Secured in Hub Storage (${selectedDrawer}). Witness:${finalPartnerEmail}`
      : `HUB RELEASE: Released from Hub for final leg. Witness:${finalPartnerEmail}`;

    const payload = {
      request_id: taskId,
      new_status: newStatus, 
      verifying_email: managerEmail, 
      courier_email: actionType === 'IN' ? courierEmail : courierEmail, // The courier assigned to the leg
      notes: noteContent
    };

    try {
      const res = await fetch("http://localhost:8000/verify-handoff", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setVerifyingEmail('');
        setSelectedDrawer('');
        await fetchHubData();
        if (actionType === 'IN') setActiveTab('STORAGE');
        if (actionType === 'OUT') setActiveTab('HISTORY');
      } else {
        const errorData = await res.json();
        alert(`Security Error: ${errorData.detail}`);
      }
    } catch (err) {
      alert("Communication Error with Backend");
    } finally {
      setLoading(false);
    }
  };

  const handleSimulateStabilization = async (id: string) => {
    try {
      const res = await fetch("http://localhost:8000/simulate-sla-risk", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            request_id: id,
            minutes: 21,           
            warp_biological: true  
        })
      });
      if (res.ok) fetchHubData();
    } catch (err) {
      console.error("Simulation error", err);
    }
  };

  // --- LOGIC FILTERS (UPDATED FOR CATEGORY SENSITIVITY) ---
  const inboundTasks = tasks.filter(t => 
    t.route_type === 'HUB_RELAY' && 
    (t.relay_step === 1 || (t.relay_step === 3 && ["Pathology Samples", "Surgical Equipment"].includes(t.item_name))) && 
    ['REQUESTED', 'ACCEPTED', 'PICKED_UP'].includes(t.status)
  ); 
  
  const storageTasks = tasks.filter(t => 
    [2, 4].includes(t.relay_step) && 
    t.status === 'REQUESTED' &&
    (!t.assigned_courier || t.assigned_courier === "")
  ); 
  
  const outboundTasks = tasks.filter(t => 
    [2, 4].includes(t.relay_step) && 
    t.status === 'ACCEPTED' && 
    t.assigned_courier
  );

  const displayLogs = filter === 'IN_STORAGE' 
        ? logs.filter(l => l.status === 'IN_STORAGE') 
        : logs;

  const activeCount = logs.filter(l => l.status === 'IN_STORAGE').length;

  const filteredLogs = displayLogs.filter(log => 
    log.accession_id.toLowerCase().includes(searchQuery.toLowerCase()) || 
    log.item_name.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a,b) => new Date(b.check_in_time).getTime() - new Date(a.check_in_time).getTime());
  
  const currentDisplayTasks = 
    activeTab === 'INBOUND' ? inboundTasks : 
    activeTab === 'STORAGE' ? storageTasks : activeTab === 'OUTBOUND' ? outboundTasks : [];

  return (
    <div className="min-h-screen bg-[#f8fafc] flex font-sans antialiased text-slate-900">
      <aside className="w-80 bg-slate-900 p-10 text-white flex flex-col fixed h-full z-20 shadow-2xl">
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-black italic text-lg shadow-lg">H</div>
            <h2 className="text-2xl font-black tracking-tighter uppercase">MedHop <span className="text-blue-500">Hub</span></h2>
          </div>
          <div className="h-1 w-12 bg-blue-500 mb-4 rounded-full"></div>
          <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.2em]">{managerName}</p>
        </div>

        <nav className="space-y-3 flex-1">
          <button 
            onClick={() => setActiveTab('INBOUND')} 
            className={`w-full flex justify-between items-center p-5 rounded-xl text-[11px] font-black transition-all uppercase tracking-widest ${activeTab === 'INBOUND' ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Inbound Pipeline</span>
            {inboundTasks.length > 0 && <span className="bg-white/20 text-white px-2 py-1 rounded text-[9px]">{inboundTasks.length}</span>}
          </button>

          <button 
            onClick={() => setActiveTab('STORAGE')} 
            className={`w-full flex justify-between items-center p-5 rounded-xl text-[11px] font-black transition-all uppercase tracking-widest ${activeTab === 'STORAGE' ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Stabilization Vault</span>
          </button>

          <button 
            onClick={() => setActiveTab('OUTBOUND')} 
            className={`w-full flex justify-between items-center p-5 rounded-xl text-[11px] font-black transition-all uppercase tracking-widest ${activeTab === 'OUTBOUND' ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Dispatch Control</span>
            {outboundTasks.length > 0 && <span className="bg-green-500/20 text-green-400 px-2 py-1 rounded text-[9px]">{outboundTasks.length}</span>}
          </button>

          <button 
            onClick={() => setActiveTab('HISTORY')} 
            className={`w-full text-left p-5 rounded-xl text-[11px] font-black transition-all uppercase tracking-widest ${activeTab === 'HISTORY' ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            Archived Registry
          </button>
        </nav>
        
        <div className="mt-auto pt-8 border-t border-slate-800">
             <div className="p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
                <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Station Node</p>
                <p className="text-xs font-bold text-white truncate italic uppercase tracking-tighter">TRANSIT_HUB_ALPHA</p>
             </div>
        </div>
      </aside>

      <main className="flex-1 ml-80 p-16">
        <header className="mb-16 flex justify-between items-end border-b border-slate-200 pb-8">
          <div>
            <h1 className="text-5xl font-black uppercase tracking-tighter text-slate-900">
              {activeTab === 'INBOUND' ? 'Specimen Intake' : activeTab === 'STORAGE' ? 'Vault Inventory' : activeTab === 'OUTBOUND' ? 'Pending Dispatch' : 'Operations Log'}
            </h1>
            <div className="h-2 w-24 bg-blue-600 mt-4 rounded-full"></div>
          </div>
          
          {activeTab === 'HISTORY' && (
            <div className="bg-orange-500 text-white px-8 py-4 rounded-3xl shadow-lg border-b-4 border-orange-700">
                <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Vault Inventory</p>
                <p className="text-2xl font-black">{activeCount} <span className="text-sm">Units</span></p>
            </div>
          )}
          
          <button 
            onClick={() => Notification.requestPermission()}
            className="bg-slate-900 text-white px-8 py-4 text-[10px] font-black uppercase tracking-[0.2em] hover:bg-red-600 transition-all rounded-xl shadow-lg"
          >
            Force Security Handshake
          </button>
        </header>

        {activeTab === 'HISTORY' ? (
          <div className="bg-white shadow-2xl rounded-4xl border border-slate-200 overflow-hidden">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                <div className="flex bg-white border rounded-2xl p-1 gap-1">
                    <button 
                        onClick={() => setFilter('IN_STORAGE')}
                        className={`px-6 py-2 rounded-xl text-xs font-black transition-all ${filter === 'IN_STORAGE' ? 'bg-slate-900 text-white' : 'text-slate-400'}`}
                    >
                        Active Vault
                    </button>
                    <button 
                        onClick={() => setFilter('ALL')}
                        className={`px-6 py-2 rounded-xl text-xs font-black transition-all ${filter === 'ALL' ? 'bg-slate-900 text-white' : 'text-slate-400'}`}
                    >
                        Full History
                    </button>
                </div>
                <input 
                    type="text" 
                    placeholder="Search accession ID..." 
                    className="px-6 py-3 border rounded-xl text-xs outline-none w-80 bg-white shadow-inner" 
                    value={searchQuery} 
                    onChange={(e) => setSearchQuery(e.target.value)} 
                />
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white border-b border-slate-200">
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest">Specimen / LIS</th>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest">Storage Slot</th>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Hub Check-in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.length === 0 ? (
                  <tr><td colSpan={4} className="p-32 text-center text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Vault empty in this sector</td></tr>
                ) : filteredLogs.map(log => (
                  <tr key={log.id} className="hover:bg-blue-50/30 transition-colors">
                    <td className="p-8">
                      <p className="font-bold text-slate-800">{log.item_name}</p>
                      <p className="text-xs font-mono text-blue-600 bg-blue-50 inline-block px-2 py-0.5 rounded mt-1">ACC-{log.accession_id}</p>
                    </td>
                    <td className="p-8">
                        <span className="px-3 py-1 bg-slate-900 text-white rounded-lg font-black text-[10px] uppercase tracking-widest">
                            {log.storage_slot}
                        </span>
                    </td>
                    <td className="p-8">
                        <span className={`px-3 py-1 rounded-lg font-black text-[9px] uppercase tracking-widest ${
                            log.status === 'IN_STORAGE' ? 'bg-orange-100 text-orange-600 border border-orange-200' : 'bg-green-100 text-green-600'
                        }`}>
                            {log.status.replace('_', ' ')}
                        </span>
                    </td>
                    <td className="p-8 text-right">
                      <p className="text-[11px] font-black text-slate-900 uppercase">{new Date(log.check_in_time).toLocaleDateString([], {month: 'short', day: '2-digit'})}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">{new Date(log.check_in_time).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : activeTab === 'STORAGE' ? (
          <div className="space-y-12 animate-in fade-in duration-700">
            <div className="grid grid-cols-3 gap-8">
              {Object.entries(VAULT_STRUCTURE).map(([category, data]) => (
                <div key={category} className="bg-white p-10 rounded-[2.5rem] border border-slate-200 shadow-xl">
                  <div className="flex justify-between items-center mb-8">
                       <h4 className="text-[11px] font-black uppercase text-slate-400 tracking-[0.2em]">{category} Zone</h4>
                       <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                  </div>
                  <div className="space-y-8">
                    {data.lockers.map(locker => {
                      const count = drawerOccupancy[locker] || 0;
                      const percent = (count / data.capacity) * 100;
                      return (
                        <div key={locker}>
                          <div className="flex justify-between text-[10px] font-black mb-3 uppercase tracking-widest">
                            <span className="text-slate-700">{locker}</span>
                            <span className={count >= data.capacity ? "text-red-600 font-black" : "text-blue-600"}>{count}/{data.capacity}</span>
                          </div>
                          <div className="w-full h-2 bg-slate-100 overflow-hidden rounded-full border border-slate-50 shadow-inner">
                            <div 
                              className={`h-full transition-all duration-1000 ease-out ${count >= data.capacity ? 'bg-red-500' : 'bg-blue-600'}`} 
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-6">
                <div className="flex items-center gap-4 mb-8">
                    <h3 className="text-[12px] font-black text-slate-400 uppercase tracking-[0.4em]">Stabilization Registry</h3>
                    <div className="flex-1 h-px bg-slate-200"></div>
                </div>
                {storageTasks.length === 0 ? (
                  <div className="py-24 text-center bg-white border-2 border-dashed border-slate-200 rounded-[3rem] shadow-inner">
                    <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] italic">No specimens in stabilization</p>
                  </div>
                ) : storageTasks.map(task => {
                  const arrivalTime = new Date(task.created_at).getTime();
                  const remaining = Math.max(0, (20 * 60 * 1000) - (now - arrivalTime));
                  const isStabilized = remaining <= 0;
                  const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(task.item_name);

                  return (
                    <div key={task.id} className="bg-white p-12 rounded-[3rem] border border-slate-200 flex justify-between items-center group hover:border-blue-500 transition-all hover:shadow-2xl">
                        <div className="space-y-4">
                            <div className="flex gap-3">
                                <span className="text-[9px] font-black px-3 py-1.5 bg-blue-50 text-blue-600 border border-blue-100 rounded-lg uppercase">Leg {task.relay_step}/{isScenarioA ? '4' : '2'}</span>
                                {task.lab_results && <span className="text-[9px] font-black px-3 py-1.5 bg-green-50 text-green-600 border border-green-100 rounded-lg uppercase tracking-tighter">Return Transport</span>}
                                <span className="text-[9px] font-black px-3 py-1.5 bg-slate-900 text-white rounded-lg uppercase tracking-tighter font-mono italic">LIS-{task.accession_id}</span>
                            </div>
                            <h4 className="font-black text-slate-900 text-3xl uppercase tracking-tighter italic">{task.item_name}</h4>
                            <div className="flex items-center gap-2 text-blue-600">
                                <div className="w-1.5 h-1.5 bg-blue-600 rounded-full"></div>
                                <p className="text-[11px] font-black uppercase tracking-widest font-mono">Vault Storage Unit: {task.notes?.match(/\(([^)]+)\)/)?.[1] || "UNMAPPED"}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-12">
                            <div className="text-right">
                                <div className={`text-[10px] font-black uppercase tracking-widest mb-3 ${isStabilized ? 'text-green-600' : 'text-orange-500'}`}>
                                    {isStabilized ? 'Protocol: Stabilization Verified' : `Wait Period: ${Math.floor(remaining / 60000)}m ${Math.floor((remaining % 60000) / 1000)}s`}
                                </div>
                                <div className="w-56 h-1.5 bg-slate-100 overflow-hidden rounded-full shadow-inner border border-slate-50">
                                    <div className="h-full bg-blue-600 transition-all duration-1000" style={{ width: `${Math.min(100, (1 - remaining/(20*60*1000))*100)}%` }} />
                                </div>
                            </div>
                            <button 
                                onClick={() => handleSimulateStabilization(task.id)} 
                                className="px-8 py-4 bg-slate-50 text-slate-900 border-2 border-slate-100 text-[10px] font-black uppercase tracking-widest hover:bg-slate-900 hover:text-white transition-all rounded-2xl shadow-sm"
                            >
                                Manual Warp
                            </button>
                        </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-10 animate-in slide-in-from-bottom-6 duration-500">
            {currentDisplayTasks.length === 0 ? (
                <div className="py-40 text-center bg-white border-2 border-dashed border-slate-200 rounded-[4rem]">
                    <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.4em]">Operations Sector Baseline</p>
                </div>
            ) : currentDisplayTasks.map(task => {
              const compliant = getCompliantDrawers(task.temperature_req);
              const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(task.item_name);
              
              return (
                <div key={task.id} className="bg-white p-16 rounded-[4rem] border-2 border-slate-100 relative overflow-hidden group hover:border-blue-600 transition-all hover:shadow-2xl shadow-lg">
                  <div className="flex justify-between items-start">
                    <div className="space-y-8 flex-1">
                      <div className="flex gap-4">
                        <span className="bg-slate-900 text-white text-[10px] font-black px-4 py-2 rounded-xl uppercase tracking-[0.2em] shadow-lg">{task.temperature_req}</span>
                        <span className="bg-blue-50 text-blue-600 text-[10px] font-black px-4 py-2 rounded-xl uppercase tracking-widest border border-blue-100 font-mono shadow-sm">LIS-{task.accession_id}</span>
                        {task.lab_results && <span className="bg-green-600 text-white text-[10px] font-black px-4 py-2 rounded-xl uppercase tracking-widest shadow-lg animate-pulse">Return Mission</span>}
                      </div>
                      <div>
                        <h3 className="text-5xl font-black text-slate-900 uppercase tracking-tighter italic mb-2">{task.item_name}</h3>
                        <div className="flex items-center gap-6 text-slate-400">
                            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-blue-600 italic">Origin: {task.pickup_location}</p>
                            <div className="h-px w-12 bg-slate-200"></div>
                            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-slate-900 italic">Target: {task.dropoff_location}</p>
                        </div>
                      </div>
                      <div className="p-6 bg-slate-50 rounded-4xl border border-slate-100 inline-block">
                           <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Protocol Phase</p>
                           <p className="text-lg font-black text-slate-700 uppercase tracking-tighter mt-1">Leg {task.relay_step} of {isScenarioA ? '4' : '2'} - Hub Processing</p>
                      </div>
                    </div>

                    <div className="w-md p-10 bg-slate-50 border-l border-slate-100 space-y-8 rounded-r-[4rem] flex flex-col justify-center">
                      {activeTab === 'INBOUND' && (
                        <>
                          <div className="space-y-4">
                            <label className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">Assign Storage Node</label>
                            <select 
                              className="w-full p-6 bg-white border-2 border-slate-200 rounded-4xl text-sm font-black uppercase outline-none focus:border-blue-500 shadow-inner transition-all" 
                              value={selectedDrawer} 
                              onChange={(e) => setSelectedDrawer(e.target.value)}
                            >
                              <option value="">Select Target Unit</option>
                              {compliant.map(d => {
                                const count = drawerOccupancy[d] || 0;
                                return <option key={d} value={d} disabled={count >= DRAWER_MAX_CAPACITY}>{d} ({count}/{DRAWER_MAX_CAPACITY} FULL)</option>;
                              })}
                            </select>
                          </div>
                          {/* BUTTON MODIFIED: Strictly triggers 'AT_CHECKPOINT' for audit integrity */}
                          <button 
                            disabled={loading || task.status !== 'PICKED_UP' || !selectedDrawer} 
                            onClick={() => handleStatusUpdate(task.id, 'AT_CHECKPOINT', 'IN', task.assigned_courier)} 
                            className="w-full py-7 bg-blue-600 text-white rounded-4xl text-[12px] font-black uppercase tracking-[0.3em] disabled:opacity-20 active:scale-95 transition-all shadow-xl hover:bg-blue-700"
                          >
                            {loading ? 'Transmitting...' : 'Validate & Secure'}
                          </button>
                        </>
                      )}

                      {activeTab === 'OUTBOUND' && (
                        <>
                          <div className="space-y-4">
                            <label className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">Authorized Dispatch Asset</label>
                            <div className="p-6 bg-white border-2 border-slate-200 rounded-4xl text-sm font-black uppercase text-slate-900 truncate shadow-inner italic">
                                {task.assigned_courier || "Awaiting Assignment"}
                            </div>
                            <input 
                                type="email" 
                                placeholder="Verification (Hub Manager Email)" 
                                className="w-full p-6 bg-white border-2 border-slate-100 rounded-4xl text-[10px] font-black uppercase tracking-widest outline-none focus:border-green-500"
                                value={verifyingEmail}
                                onChange={(e) => setVerifyingEmail(e.target.value)}
                            />
                          </div>
                          {/* RELEASE CONTROL: The Courier B (assigned_courier) is the receiver, 
                              Manager provides verifyingEmail signature. Package leaves Hub and 
                              becomes visible to the courier. */}
                          <button 
                            disabled={loading || !verifyingEmail || !task.assigned_courier} 
                            onClick={() => handleStatusUpdate(task.id, 'PICKED_UP', 'OUT', task.assigned_courier)} 
                            className="w-full py-7 bg-slate-900 text-white rounded-4xl text-[12px] font-black uppercase tracking-[0.3em] hover:bg-green-600 transition-all shadow-xl disabled:opacity-20"
                          >
                            Release Control
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}