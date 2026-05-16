import React, { useState, useEffect } from 'react';

type LogisticsStatus = 'REQUESTED' | 'ACCEPTED' | 'PICKED_UP' | 'AT_CHECKPOINT' | 'DELIVERED' | 'RECEIVED_VERIFIED' | 'CANCELLED' | 'EXPIRED' | 'PROCESSING' | 'COMPLETED';

interface CourierTask {
  id: string; item_name: string; pickup_location: string; dropoff_location: string;
  priority: 'NORMAL' | 'EMERGENCY'; status: LogisticsStatus; accession_id: string;
  temperature_req: string; assigned_courier?: string; created_at: string;
  mission_start_time: string; current_location: string;
  route_type: 'DIRECT' | 'HUB_RELAY';
  hub_id?: string;
  relay_step: number;
  lab_results?: string; // Used to detect return legs
}

// --- UPDATED SLA LOGIC: CATEGORY + ROUTE AWARE PER INTENT ---
const getSLADetails = (missionStartTime: string, priority: string, status: string, routeType: string = 'DIRECT', itemName: string = "") => {
  const terminalStates = ['CANCELLED', 'RECEIVED_VERIFIED', 'EXPIRED', 'COMPLETED'];
  if (terminalStates.includes(status)) return { time: status, isCritical: false, stopped: true, remainingMs: 0 };
  
  const start = new Date(missionStartTime).getTime();
  const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(itemName);
  
  // Rule: Circular loop (Scenario A + Hub Relay) gets 4h (14.4m ms). 
  // Everything else (Medicine Hub Relay or any DIRECT trip) gets 2h (7.2m ms).
  let baseLimit = (routeType === 'HUB_RELAY' && isScenarioA) ? 14400000 : 7200000;

  // EMERGENCY RULE: Timing is cut in half
  const limit = priority === 'EMERGENCY' ? baseLimit / 2 : baseLimit;
  
  const diff = (start + limit) - Date.now();
  
  if (diff <= 0 || status === 'EXPIRED') return { time: "EXPIRED", isCritical: true, stopped: true, remainingMs: 0 };
  
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  
  return { 
    time: `${h}h ${m}m ${s}s`, 
    isCritical: diff < 900000,
    stopped: false,
    remainingMs: diff
  };
};

export default function CourierDashboard() {
  const [activeTab, setActiveTab] = useState<'FEED' | 'MY_TASKS' | 'HISTORY'>('FEED');
  const [requests, setRequests] = useState<CourierTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showAbortModal, setShowAbortModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<CourierTask | null>(null);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [abortReason, setAbortReason] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([]);
  const [ticker, setTicker] = useState(0);
  const [alertedTaskIds, setAlertedTaskIds] = useState<string[]>([]);

  const courierEmail = localStorage.getItem('user_email') || "courier@medhop.com";

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
      new Notification(`MedHop ${type === 'CRITICAL' ? '⚠️ URGENT' : '📥 UPDATE'}`, {
        body: `${task.item_name} | LIS: ${task.accession_id}\nStatus: ${task.status.replace('_', ' ')}`,
      });
      audio.play().catch(e => console.log("Audio play blocked by browser policy"));
    }
    
    setAlertedTaskIds(prev => [...prev, task.id]);
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch("http://localhost:8000/get-courier-tasks");
      if (res.ok) {
        const data = await res.json();
        setRequests(data);

        // Check for Critical SLA alerts on current tasks
        data.forEach((t: CourierTask) => {
          if (t.assigned_courier === courierEmail) {
             const sla = getSLADetails(t.mission_start_time, t.priority, t.status, t.route_type, t.item_name);
             if (sla.isCritical && !sla.stopped) {
                triggerTacticalAlert(t, 'CRITICAL');
             }
          }
        });
      }
    } catch (err) { console.error("Sync Error:", err); } finally { setLoading(false); }
  };

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    const clock = setInterval(() => setTicker(t => t + 1), 1000);
    return () => { clearInterval(interval); clearInterval(clock); };
  }, [alertedTaskIds]);

  const confirmStatusUpdate = async (taskId: string, nextStatus: LogisticsStatus, witness: string, notes: string = "") => {
    setRequests(prev => prev.map(r => r.id === taskId ? { 
        ...r, 
        status: nextStatus, 
        assigned_courier: nextStatus === 'AT_CHECKPOINT' ? undefined : courierEmail 
    } : r));
    
    setShowVerifyModal(false); setShowAbortModal(false); setIsProcessing(true);
    try {
      const res = await fetch("http://localhost:8000/verify-handoff", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: taskId, verifying_email: witness, new_status: nextStatus, courier_email: courierEmail, notes: notes }),
      });
      if (res.ok) { setWitnessEmail(''); setAbortReason(''); await fetchTasks(); }
      else { const errorData = await res.json(); alert(`Action failed: ${errorData.detail}`); fetchTasks(); }
    } catch (err) { fetchTasks(); } finally { setIsProcessing(false); }
  };

  const handleReleaseAssignment = async (taskId: string) => {
    if (!window.confirm("Release this mission back to the Global Feed? Another agent will need to claim it.")) return;
    
    setIsProcessing(true);
    try {
      const res = await fetch(`http://localhost:8000/release-assignment?request_id=${taskId}&courier_email=${courierEmail}`, {
        method: 'PUT'
      });
      if (res.ok) {
        await fetchTasks();
        setActiveTab('FEED');
      } else {
        const errorData = await res.json();
        alert(`Release Blocked: ${errorData.detail}`);
        fetchTasks();
      }
    } catch (err) {
      console.error(err);
      fetchTasks();
    } finally {
      setIsProcessing(false);
    }
  };

  // --- REFINED INSTRUCTION ENGINE FOR CATEGORY-AWARE 4-LEG RELAY ---
  const getNextInstruction = (task: CourierTask) => {
    const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(task.item_name);
    const isReturn = !!task.lab_results && isScenarioA;

    switch (task.status) {
      case 'ACCEPTED':
        return {
          text: `Proceed to ${task.pickup_location}`,
          sub: isReturn ? "Pickup Results (Leg 3/4)" : (task.relay_step === 2 ? "Hub Pickup (Leg 2/4)" : "Initial Pickup"),
          color: "text-blue-600"
        };
      case 'PICKED_UP':
        if (task.route_type === 'HUB_RELAY' && (task.relay_step === 1 || (isScenarioA && task.relay_step === 3))) {
          return {
            text: "Deliver to Central Hub",
            sub: "Mandatory Security Checkpoint",
            color: "text-orange-600"
          };
        }
        return {
          text: `Deliver to ${task.dropoff_location}`,
          sub: isReturn ? "Final Handover to Hospital" : (task.relay_step === 2 ? "Dispatch to Lab" : "Direct Sprint"),
          color: "text-green-600"
        };
      case 'AT_CHECKPOINT':
        return {
          text: `Proceed to ${task.dropoff_location}`,
          sub: isReturn ? "Final Return Leg" : "Final Delivery Leg",
          color: "text-indigo-600"
        };
      default:
        return { text: "Complete Process", sub: "Awaiting Update", color: "text-slate-400" };
    }
  };

  // UPDATED: Filter out 'COMPLETED' from active list
  const myTasks = requests.filter(t => 
    t.assigned_courier === courierEmail && 
    !['DELIVERED', 'RECEIVED_VERIFIED', 'EXPIRED', 'CANCELLED', 'COMPLETED'].includes(t.status)
  );

  const myAlerts = requests.filter(t => 
    t.assigned_courier === courierEmail && 
    t.status === 'CANCELLED' && 
    !acknowledgedIds.includes(t.id)
  );
  
  const canTakeMore = (newTask: CourierTask) => {
    if (myTasks.length === 0) return true;
    return myTasks.some(mine => 
      mine.pickup_location === newTask.pickup_location && 
      mine.dropoff_location === newTask.dropoff_location
    );
  };

  const feedTasks = requests.filter(t => {
    const isUnassigned = !t.assigned_courier || t.assigned_courier === '';
    const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(t.item_name);

    if (t.status === 'REQUESTED' && isUnassigned) {
        // Apply stabilization rule for hub pickups (Step 2 and Scenario-A Step 4)
        if (t.relay_step === 2 || (isScenarioA && t.relay_step === 4)) {
            const entryTime = new Date(t.created_at).getTime(); 
            const isStabilized = (Date.now() - entryTime) > (20 * 60 * 1000);
            if (isStabilized) {
              triggerTacticalAlert(t, 'NEW_MISSION');
              return true;
            }
            return false;
        }
        return true;
    }
    return false;
  });
  
  // UPDATED: Include 'COMPLETED' in History
  const historyTasks = requests.filter(t => 
    t.assigned_courier === courierEmail && 
    (['DELIVERED', 'RECEIVED_VERIFIED', 'EXPIRED', 'COMPLETED'].includes(t.status) || (t.status === 'CANCELLED' && acknowledgedIds.includes(t.id)))
  );

  const myTasksDisplay = [...myTasks, ...myAlerts];
  const activeDisplayList = activeTab === 'FEED' ? feedTasks : activeTab === 'MY_TASKS' ? myTasksDisplay : historyTasks;

  return (
    <div className="min-h-screen bg-[#f8fafc] flex font-sans">
      <aside className="w-72 bg-slate-900 p-6 flex flex-col fixed h-full z-20 shadow-2xl">
        <div className="flex items-center gap-3 mb-10 px-2">
          <div className="w-8 h-8 bg-[#4CAF50] rounded-lg flex items-center justify-center font-black text-white italic">GO</div>
          <h2 className="font-bold text-white text-xl tracking-tighter">MedHop <span className="text-[#4CAF50]">Go</span></h2>
        </div>
        
        <nav className="space-y-2 flex-1">
          <button onClick={() => setActiveTab('FEED')} className={`w-full flex justify-between items-center p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'FEED' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>
            <span>Global Feed</span>
            {feedTasks.length > 0 && <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${activeTab === 'FEED' ? 'bg-white text-[#4CAF50]' : 'bg-[#4CAF50] text-white'}`}>{feedTasks.length}</span>}
          </button>
          
          <button onClick={() => setActiveTab('MY_TASKS')} className={`w-full flex justify-between items-center p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'MY_TASKS' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>
            <span>Active Tasks</span>
            {myTasksDisplay.length > 0 && <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${activeTab === 'MY_TASKS' ? 'bg-white text-[#4CAF50]' : 'bg-[#4CAF50] text-white'}`}>{myTasksDisplay.length}</span>}
          </button>
          
          <button onClick={() => setActiveTab('HISTORY')} className={`w-full text-left p-4 rounded-2xl text-sm font-bold transition-all ${activeTab === 'HISTORY' ? 'bg-[#4CAF50] text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>Job History</button>
        </nav>

        <div className="mt-auto p-4 bg-slate-800/50 rounded-2xl">
          <p className="text-[10px] font-black text-slate-500 uppercase mb-1 tracking-widest">Active Courier</p>
          <p className="text-sm font-bold text-white truncate">{courierEmail}</p>
        </div>
      </aside>

      <main className="flex-1 ml-72 flex flex-col">
        <header className="h-20 bg-white border-b flex items-center px-10 sticky top-0 z-10 justify-between">
          <h1 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">
            {activeTab === 'FEED' ? "Available Requests" : activeTab === 'MY_TASKS' ? "Field Operations" : "Mission Logs"}
          </h1>
          <button 
            onClick={() => {
              Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                  new Notification("System Active", { body: "Courier Notifications linked to MedHop Go." });
                }
              });
            }}
            className="bg-red-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg hover:bg-red-700 transition-all active:scale-95"
          >
            Force Security Handshake
          </button>
        </header>

        <div className="p-10 max-w-5xl mx-auto w-full">
          {loading ? (
             <div className="py-24 text-center font-bold text-slate-400 animate-pulse uppercase tracking-widest text-[10px]">Synchronizing Fleet Data...</div>
          ) : activeDisplayList.length === 0 ? (
            <div className="py-24 text-center font-bold text-slate-400 bg-white border-2 border-dashed rounded-[3rem]">No assets found in current sector.</div>
          ) : (
            <div className="space-y-6">
              {activeDisplayList.map((task) => {
                const sla = getSLADetails(task.mission_start_time, task.priority, task.status, task.route_type, task.item_name);
                const isCancelled = task.status === 'CANCELLED';
                const canAccept = activeTab === 'FEED' ? canTakeMore(task) : true;
                const instruction = activeTab === 'MY_TASKS' && !isCancelled ? getNextInstruction(task) : null;
                const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(task.item_name);

                return (
                  <div key={task.id} className={`p-8 rounded-[3rem] border-2 shadow-sm transition-all relative overflow-hidden ${
                    isCancelled ? 'bg-red-50 border-red-200' :
                    !canAccept && activeTab === 'FEED' ? 'bg-slate-50 border-slate-100 opacity-60 grayscale blur-[0.5px]' :
                    sla.isCritical ? 'bg-red-950 border-red-600 text-white animate-pulse' : 'bg-white border-slate-100'
                  }`}>
                    {/* Leg Notification Badge */}
                    {task.relay_step >= 2 && !isCancelled && (
                      <div className="absolute top-0 right-0 bg-indigo-600 text-white px-6 py-2 rounded-bl-3xl font-black text-[10px] uppercase tracking-widest animate-pulse shadow-lg z-10">
                        {!!task.lab_results ? `Scenario-A Return: Step ${task.relay_step}/4` : `Outbound: Step ${task.relay_step}/${isScenarioA ? '4' : '2'}`}
                      </div>
                    )}

                    <div className="flex justify-between items-start">
                      <div className="space-y-4">
                        <div className="flex gap-2">
                          <span className={`text-[10px] font-black px-3 py-1 rounded-lg uppercase shadow-sm ${isCancelled ? 'bg-red-600 text-white' : task.priority === 'EMERGENCY' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'}`}>
                            {isCancelled ? 'CANCELLED' : task.priority}
                          </span>
                          <span className="text-[10px] font-bold px-3 py-1 bg-slate-100 text-slate-500 rounded-lg uppercase">
                            {task.relay_step > 0 ? `Relay Leg ${task.relay_step}/${isScenarioA ? '4' : '2'}` : `Step 1/1: Direct Path`}
                          </span>
                        </div>
                        
                        {instruction && (
                          <div className="mb-2">
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Next Objective</p>
                            <h3 className={`text-lg font-bold ${instruction.color}`}>{instruction.text}</h3>
                            <p className="text-[10px] font-medium text-slate-500 italic">{instruction.sub}</p>
                          </div>
                        )}

                        <div>
                          <h4 className={`font-bold text-3xl mb-1 tracking-tight ${sla.isCritical && !isCancelled ? 'text-white' : 'text-slate-800'}`}>{task.item_name}</h4>
                          <p className={`text-sm font-bold uppercase ${sla.isCritical && !isCancelled ? 'text-white/60' : 'text-slate-400'}`}>
                            {task.pickup_location} <span className="mx-2 text-[#4CAF50]">→</span> {task.dropoff_location}
                          </p>
                        </div>

                        <div className="flex gap-3">
                          <span className={`px-3 py-1 text-[10px] font-black rounded-lg uppercase ${sla.isCritical && !isCancelled ? 'bg-white/20 text-white' : 'bg-blue-50 text-blue-600'}`}>LIS: {task.accession_id}</span>
                          <span className={`px-3 py-1 text-[10px] font-black rounded-lg uppercase ${sla.isCritical && !isCancelled ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>Thermal: {task.temperature_req}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <p className={`text-[10px] font-black uppercase mb-1 ${sla.isCritical && !isCancelled ? 'text-white/40' : 'text-slate-400'}`}>SLA Clock</p>
                        <div className={`font-mono text-4xl font-black mb-4 tracking-tighter ${isCancelled ? 'text-red-600' : ''}`}>
                          {sla.time}
                        </div>
                        <div className={`inline-block px-3 py-1 rounded-lg text-[10px] font-black uppercase ${sla.isCritical && !isCancelled ? 'bg-white text-red-900' : 'bg-slate-100 text-slate-600'}`}>
                          {task.status.replace('_', ' ')}
                        </div>
                      </div>
                    </div>

                    {activeTab !== 'HISTORY' && (
                      <div className="flex flex-col gap-3 mt-8">
                        {isCancelled ? (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setAcknowledgedIds(prev => [...prev, task.id]); }} 
                            className="w-full py-5 bg-red-600 text-white rounded-4xl font-black uppercase text-[11px] tracking-widest shadow-xl hover:bg-red-700 transition-all active:scale-95"
                          >
                            Acknowledge Alert
                          </button>
                        ) : activeTab === 'FEED' ? (
                          <button 
                            disabled={!canAccept}
                            onClick={() => confirmStatusUpdate(task.id, 'ACCEPTED', '')} 
                            className={`w-full py-5 rounded-4xl font-black uppercase text-[11px] tracking-widest shadow-xl transition-all ${canAccept ? 'bg-[#4CAF50] text-white hover:scale-[1.01]' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
                          >
                            {task.relay_step > 1 ? "Claim Relay Leg" : "Claim Assignment"}
                          </button>
                        ) : (
                          <>
                            <button 
                              onClick={() => { setSelectedTask(task); setShowVerifyModal(true); }} 
                              className="w-full bg-[#4CAF50] text-white py-5 rounded-4xl font-black uppercase text-[11px] tracking-widest shadow-xl hover:bg-green-700 transition-all active:scale-95"
                            >
                              {task.status === 'ACCEPTED' ? "Verify Physical Pickup" : 
                               (task.status === 'PICKED_UP' && task.route_type === 'HUB_RELAY' && [1, 3].includes(task.relay_step)) ? "Check-in at Hub" :
                               "Arrival at Destination"}
                            </button>
                            <div className="flex gap-3">
                              {task.status === 'ACCEPTED' && (
                                <button 
                                  onClick={() => handleReleaseAssignment(task.id)}
                                  disabled={isProcessing}
                                  className="flex-1 py-4 bg-white border-2 border-slate-300 text-slate-600 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-slate-100 hover:border-slate-400 transition-all disabled:opacity-50"
                                >
                                  Leave Request
                                </button>
                              )}
                              <button 
                                onClick={() => { setSelectedTask(task); setShowAbortModal(true); }} 
                                className="flex-1 py-4 bg-red-50 border-2 border-red-200 text-red-600 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-red-600 hover:text-white hover:border-red-600 transition-all"
                              >
                                Abort Protocol
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {showVerifyModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-100 flex items-center justify-center p-6">
          <div className="bg-white border border-slate-200 p-10 rounded-[3rem] w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-black uppercase mb-4 tracking-tighter text-slate-800 text-center">Protocol verification</h2>
            <p className="text-[10px] text-slate-400 mb-6 font-bold uppercase tracking-widest text-center">Handover requires handler validation</p>
            <input type="email" placeholder="STAFF_EMAIL_NODE" className="w-full p-4 bg-slate-50 border rounded-2xl mb-6 outline-none text-sm font-bold text-slate-700 focus:ring-2 focus:ring-[#4CAF50]" value={witnessEmail} onChange={e => setWitnessEmail(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => { setShowVerifyModal(false); setWitnessEmail(''); }} className="flex-1 py-4 font-bold text-slate-400 uppercase text-xs">Cancel</button>
              <button 
                onClick={() => {
                  let next: LogisticsStatus = 'ACCEPTED';
                  const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(selectedTask?.item_name || "");
                  if (selectedTask?.status === 'ACCEPTED') next = 'PICKED_UP';
                  else if (selectedTask?.status === 'PICKED_UP') {
                    const needsCheckin = selectedTask.route_type === 'HUB_RELAY' && (selectedTask.relay_step === 1 || (isScenarioA && selectedTask.relay_step === 3));
                    next = needsCheckin ? 'AT_CHECKPOINT' : 'DELIVERED';
                  } else if (selectedTask?.status === 'AT_CHECKPOINT') {
                    next = 'DELIVERED';
                  }
                  confirmStatusUpdate(selectedTask!.id, next, witnessEmail);
                }} 
                disabled={!witnessEmail || isProcessing} className="flex-2 py-4 bg-[#4CAF50] text-white rounded-xl font-bold uppercase text-xs shadow-lg disabled:opacity-50"
              >
                {(selectedTask?.status === 'PICKED_UP' && selectedTask.route_type === 'HUB_RELAY' && (selectedTask.relay_step === 1 || (["Pathology Samples", "Surgical Equipment"].includes(selectedTask?.item_name || "") && selectedTask.relay_step === 3))) ? "Confirm Hub Storage" : "Sign Handover"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAbortModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-100 flex items-center justify-center p-6">
          <div className="bg-white border border-slate-200 p-10 rounded-[3rem] w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-black uppercase mb-4 tracking-tighter text-red-600 text-center">Report Incident</h2>
            <textarea placeholder="Reason for protocol termination..." className="w-full h-32 p-4 bg-slate-50 border rounded-2xl mb-6 outline-none text-sm text-slate-700 focus:ring-2 focus:ring-red-400" value={abortReason} onChange={(e) => setAbortReason(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => { setShowAbortModal(false); setAbortReason(''); }} className="flex-1 py-4 font-bold text-slate-400 uppercase text-xs">Back</button>
              <button onClick={() => confirmStatusUpdate(selectedTask!.id, 'CANCELLED', '', `COURIER ABORT: ${abortReason}`)} disabled={!abortReason || isProcessing} className="flex-2 py-4 bg-red-600 text-white rounded-xl font-bold uppercase text-xs shadow-lg">Confirm Terminate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}