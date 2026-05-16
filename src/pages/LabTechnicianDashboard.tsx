import React, { useState, useEffect } from 'react';

// Updated Statuses to include Scenario A circular flow and fix type overlap
type LogisticsStatus = 'DELIVERED' | 'RECEIVED_VERIFIED' | 'CANCELLED' | 'PROCESSING' | 'REQUESTED' | 'COMPLETED';

interface LabTask {
  id: string;
  item_name: string;
  accession_id: string;
  pickup_location: string;
  dropoff_location: string;
  temperature_req: string;
  status: LogisticsStatus;
  created_at: string;
  mission_start_time: string; // Added for SLA sync
  notes?: string;
  lab_results?: string; // New field for results display
  priority: 'NORMAL' | 'EMERGENCY'; // Added for system consistency
  route_type: 'DIRECT' | 'HUB_RELAY'; // Added for system consistency
}

export default function LabTechnicianDashboard() {
  const [tasks, setTasks] = useState<LabTask[]>([]);
  const [activeTab, setActiveTab] = useState<'INTAKE' | 'PROCESSING' | 'HISTORY'>('INTAKE');
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<LabTask | null>(null);
  const [integrityNotes, setIntegrityNotes] = useState('Specimen Intact, Temperature Nominal');
  const [result, setResult] = useState(""); // State for return transport results
  const [isProcessing, setIsProcessing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  const labTechEmail = localStorage.getItem('user_email') || "hamid@medhop.com";
  const labTechName = localStorage.getItem('user_name') || "Lab Technician";

  const fetchTasks = async () => {
    try {
      const res = await fetch("http://localhost:8000/get-courier-tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch (err) { 
      console.error("Sync Error:", err); 
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 4000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
        clearInterval(interval);
        clearInterval(clock);
    };
  }, []);

  const handleFinalReceipt = async () => {
    if (!selectedTask) return;
    setIsProcessing(true);
    try {
      const res = await fetch("http://localhost:8000/verify-handoff", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: selectedTask.id,
          verifying_email: labTechEmail, 
          new_status: 'RECEIVED_VERIFIED',
          courier_email: "LAB_INTAKE_SYSTEM", 
          notes: integrityNotes
        }),
      });

      if (res.ok) {
        setShowVerifyModal(false);
        setIntegrityNotes('Specimen Intact, Temperature Nominal');
        setActiveTab('PROCESSING');
        fetchTasks();
      } else {
        const errorData = await res.json();
        alert(`Security Error: ${errorData.detail}`);
      }
    } catch (err) { 
      alert("Network Error: Verification failed."); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  const handleSimulateAnalysis = async (taskId: string) => {
    try {
        const res = await fetch("http://localhost:8000/simulate-sla-risk", {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                request_id: taskId,
                minutes: 21, // Warp 21 mins to clear the 20 min lock
                warp_biological: true 
            })
        });
        if (res.ok) await fetchTasks();
    } catch (err) {
        console.error("Simulation failed", err);
    }
  };

  const handleReleaseReturn = async (taskId: string) => {
    if (!result) return alert("Clinical results required for release.");
    setIsProcessing(true);
    try {
        const res = await fetch(`http://localhost:8000/submit-lab-result?request_id=${taskId}&result_data=${encodeURIComponent(result)}&technician_email=${labTechEmail}`, {
            method: 'POST'
        });

        if (res.ok) {
            alert("Results Published. Return Courier authorized.");
            setResult("");
            setActiveTab('HISTORY'); 
            await fetchTasks(); 
        } else {
            alert("Server rejected the result submission.");
        }
    } catch (err) {
        alert("Transmission failed. Check network connection.");
    } finally {
        setIsProcessing(false);
    }
  };

  const handleRejectSpecimen = async () => {
    if (!selectedTask) return;
    if (!integrityNotes || integrityNotes === 'Specimen Intact, Temperature Nominal') {
        alert("Please provide a specific explanation for the rejection/damage.");
        return;
    }

    setIsProcessing(true);
    try {
      const res = await fetch("http://localhost:8000/verify-handoff", {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: selectedTask.id,
          verifying_email: labTechEmail, 
          new_status: 'CANCELLED', 
          courier_email: "LAB_INTAKE_SYSTEM", 
          notes: `REJECTION REPORT: ${integrityNotes}` 
        }),
      });

      if (res.ok) {
        setShowVerifyModal(false);
        setIntegrityNotes('Specimen Intact, Temperature Nominal');
        fetchTasks();
      } else {
        const errorData = await res.json();
        alert(`Security Error: ${errorData.detail}`);
      }
    } catch (err) { 
      alert("Network Error: Communication failed."); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  // --- REFINED UI LOGIC FILTERS (AUTOMATIC & SORTED) ---
  
  // 1. Receiving Log: Arrivals for Leg 1 (No results yet)
  const incomingQueue = tasks
    .filter(t => t.status === 'DELIVERED' && !t.lab_results)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  
  // 2. Analysis Lab: Vanishes automatically once lab_results exist or mission is complete
  const inProcessQueue = tasks
    .filter(t => (t.status === 'PROCESSING' || t.status === 'RECEIVED_VERIFIED') && !t.lab_results)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  
  // 3. Registry History: Completed missions or cancellations (Updated to show most recent at top)
  const techHistory = tasks
    .filter(t => !!t.lab_results || t.status === 'CANCELLED' || t.status === 'COMPLETED')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="min-h-screen bg-[#f8fafc] flex font-sans">
      <aside className="w-72 bg-slate-900 p-8 text-white flex flex-col fixed h-full z-20 shadow-2xl">
        <div className="mb-12 border-b border-slate-800 pb-8">
          <div className="flex items-center gap-3 mb-2">
             <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-black italic text-lg shadow-lg">L</div>
             <h2 className="text-xl font-bold tracking-tighter uppercase">MedHop <span className="text-blue-400">Lab</span></h2>
          </div>
          <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">{labTechName}</p>
        </div>
        
        <nav className="space-y-2 flex-1">
          <button 
            onClick={() => setActiveTab('INTAKE')}
            className={`w-full flex justify-between items-center p-4 rounded-2xl text-[10px] font-black transition-all uppercase tracking-widest ${activeTab === 'INTAKE' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Receiving Log</span>
            {incomingQueue.length > 0 && <span className="bg-blue-500 text-white px-2 py-0.5 rounded-md text-[9px]">{incomingQueue.length}</span>}
          </button>

          <button 
            onClick={() => setActiveTab('PROCESSING')}
            className={`w-full flex justify-between items-center p-4 rounded-2xl text-[10px] font-black transition-all uppercase tracking-widest ${activeTab === 'PROCESSING' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Analysis Lab</span>
            {inProcessQueue.length > 0 && <span className="bg-orange-500 text-white px-2 py-0.5 rounded-md text-[9px] animate-pulse">{inProcessQueue.length}</span>}
          </button>

          <button 
            onClick={() => setActiveTab('HISTORY')}
            className={`w-full flex justify-between items-center p-4 rounded-2xl text-[10px] font-black transition-all uppercase tracking-widest ${activeTab === 'HISTORY' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <span>Registry history</span>
          </button>
        </nav>

        <div className="mt-auto p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
          <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Station Node</p>
          <p className="text-xs font-bold text-white truncate italic uppercase tracking-tighter">Lab_Alpha_Intake</p>
        </div>
      </aside>

      <main className="flex-1 ml-72 p-12">
        <header className="mb-10 flex justify-between items-center border-b border-slate-200 pb-8">
          <div>
            <h1 className="text-4xl font-black text-slate-800 uppercase tracking-tighter">
                {activeTab === 'INTAKE' ? 'Receiving Dock' : activeTab === 'PROCESSING' ? 'Active Analysis' : 'Registry History'}
            </h1>
            <div className="h-1.5 w-24 bg-blue-600 mt-3 rounded-full"></div>
          </div>
          <div className="text-right">
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Compliance Status</p>
             <p className="text-sm font-bold text-green-600 uppercase tracking-tight flex items-center gap-2 justify-end">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                QC Active
             </p>
          </div>
        </header>

        {loading ? (
            <div className="py-24 text-center font-bold text-slate-400 uppercase tracking-widest text-[10px] animate-pulse">Synchronizing Node Data...</div>
        ) : activeTab === 'INTAKE' ? (
          <div className="grid grid-cols-1 gap-6">
            {incomingQueue.length === 0 ? (
              <div className="py-32 text-center bg-white rounded-[3rem] border-2 border-dashed border-slate-200 shadow-inner">
                <p className="text-slate-400 font-bold uppercase text-xs tracking-widest italic opacity-40">Station Clear</p>
              </div>
            ) : (
              incomingQueue.map(task => (
                <div key={task.id} className="bg-white p-10 rounded-[3rem] border border-slate-200 shadow-sm flex justify-between items-center transition-all hover:shadow-md">
                  <div className="space-y-4">
                    <div className="flex gap-2">
                       <span className="text-[9px] font-black px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg uppercase border border-blue-100">Arrival Verified</span>
                       <span className="text-[9px] font-black px-3 py-1.5 bg-slate-50 text-slate-500 rounded-lg uppercase border border-slate-100 font-mono tracking-tighter">LIS ID: {task.accession_id}</span>
                    </div>
                    <div>
                      <h3 className="text-3xl font-black text-slate-800 tracking-tighter uppercase italic">{task.item_name}</h3>
                      <p className="text-xs font-bold text-slate-400 uppercase mt-1 tracking-tight">Facility Origin: {task.pickup_location}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setSelectedTask(task); setShowVerifyModal(true); }}
                    className="bg-blue-600 text-white px-10 py-5 rounded-4xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:bg-blue-700 active:scale-95 transition-all"
                  >
                    Conduct Intake
                  </button>
                </div>
              ))
            )}
          </div>
        ) : activeTab === 'PROCESSING' ? (
          <div className="grid grid-cols-1 gap-6">
            {inProcessQueue.length === 0 ? (
              <div className="py-32 text-center border-2 border-dashed border-slate-200 rounded-[3rem]">
                <p className="text-slate-400 font-bold uppercase text-xs tracking-widest opacity-40 italic">Analysis queue empty</p>
              </div>
            ) : (
              inProcessQueue.map(task => {
                const intakeTime = new Date(task.created_at).getTime();
                const elapsedMs = now - intakeTime;
                const remainingMs = Math.max(0, (20 * 60 * 1000) - elapsedMs);
                const isLocked = remainingMs > 0;
                const isScenarioA = ["Pathology Samples", "Surgical Equipment"].includes(task.item_name);

                return (
                    <div key={task.id} className="bg-white p-10 rounded-[3rem] border-2 border-blue-500 shadow-sm flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-300">
                        <div className="flex justify-between items-start">
                            <div className="flex-1">
                                <span className={`text-[9px] font-black px-3 py-1 rounded-lg uppercase border ${isLocked ? 'bg-red-50 text-red-600 border-red-100' : 'bg-green-50 text-green-600 border-green-100'}`}>
                                    {isLocked ? `Verification Lock: ${Math.floor(remainingMs/60000)}m ${Math.floor((remainingMs%60000)/1000)}s` : 'Protocol Ready'}
                                </span>
                                <h3 className="text-2xl font-black text-slate-800 uppercase mt-2 tracking-tighter">{task.item_name} | {task.accession_id}</h3>
                            </div>
                            <button 
                                onClick={() => handleSimulateAnalysis(task.id)}
                                className="px-4 py-2 bg-slate-900 text-white text-[9px] font-black rounded-xl hover:bg-indigo-600 transition-all uppercase tracking-widest shadow-lg active:scale-95"
                            >
                                Manual Warp (20m)
                            </button>
                        </div>
                        <div className="bg-slate-50 p-8 rounded-4xl border border-slate-100">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-3 tracking-widest text-center">{isScenarioA ? "Clinical Registry Input" : "DEA Manifest Reconciliation"}</p>
                            <textarea 
                                disabled={isLocked}
                                className={`w-full p-5 rounded-2xl font-bold border outline-none focus:ring-2 focus:ring-blue-500 resize-none h-24 mb-4 shadow-inner transition-all ${isLocked ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-white border-slate-200 text-slate-700'}`} 
                                placeholder={isLocked ? "Protocol in progress... wait for timer." : (isScenarioA ? "Enter clinical data for return dispatch..." : "Confirm receipt of controlled substances...")}
                                value={result}
                                onChange={(e) => setResult(e.target.value)}
                            />
                            <button 
                                onClick={() => handleReleaseReturn(task.id)}
                                disabled={isLocked || isProcessing}
                                className={`w-full py-5 rounded-2xl font-black uppercase text-[11px] tracking-widest transition-all ${isLocked ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-100'}`}
                            >
                                {isLocked ? "Awaiting Protocol Window" : isProcessing ? "Transmitting..." : isScenarioA ? "Publish & Authorize Return" : "Confirm Receipt & Reconcile"}
                            </button>
                        </div>
                    </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="bg-white rounded-[3rem] border border-slate-200 shadow-sm overflow-hidden animate-in fade-in duration-500">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b">
                <tr>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest">Medical Specimen</th>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest">Protocol Outcome</th>
                  <th className="p-8 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Intake Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {techHistory.length === 0 ? (
                  <tr><td colSpan={3} className="py-24 text-center text-slate-300 font-bold uppercase text-xs italic opacity-50">No logs found</td></tr>
                ) : (
                  techHistory.map(log => (
                    <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-8">
                        <p className="font-bold text-slate-800 text-lg uppercase italic tracking-tighter">{log.item_name}</p>
                        <p className="text-[10px] font-black text-slate-400 mt-1 font-mono uppercase">{log.accession_id}</p>
                      </td>
                      <td className="p-8">
                        <p className="text-xs font-bold text-slate-700 italic max-w-sm truncate">"{log.lab_results || "N/A"}"</p>
                        <p className="text-[9px] font-black text-slate-400 mt-2 uppercase tracking-widest">Signed: {new Date(log.created_at).toLocaleDateString()}</p>
                      </td>
                      <td className="p-8 text-right">
                        <span className={`px-5 py-2 rounded-xl font-black text-[10px] uppercase border tracking-widest ${log.status === 'CANCELLED' ? 'bg-red-50 text-red-600 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
                            {log.status === 'CANCELLED' ? 'Rejected' : 'Mission complete'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* COMPLIANCE MODAL */}
      {showVerifyModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-100 flex items-center justify-center p-6 transition-all">
          <div className="bg-white border border-slate-200 p-12 rounded-[4rem] w-full max-w-xl shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="text-center mb-10">
                <h2 className="text-3xl font-black uppercase mb-2 tracking-tighter text-slate-900 italic">Quality Sign-Off</h2>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Compliance documentation required for LIS admission</p>
            </div>
            <div className="space-y-6 mb-10">
                <div className="p-8 bg-slate-50 border-2 border-slate-100 rounded-[3rem] shadow-inner">
                  <p className="text-[10px] font-black text-slate-400 uppercase mb-3 tracking-widest">Condition Assessment / Tech Remarks</p>
                  <textarea 
                    className="w-full bg-transparent outline-none text-md font-bold text-slate-700 h-32 focus:text-blue-600 transition-colors placeholder:text-slate-300 resize-none leading-relaxed"
                    value={integrityNotes}
                    onChange={(e) => setIntegrityNotes(e.target.value)}
                  />
                </div>
            </div>
            <div className="grid grid-cols-1 gap-4">
              <button 
                onClick={handleFinalReceipt} 
                disabled={isProcessing}
                className="w-full py-6 bg-blue-600 text-white rounded-4xl font-black uppercase text-[11px] tracking-[0.2em] shadow-xl hover:bg-blue-700 active:scale-95 disabled:opacity-50"
              >
                {isProcessing ? "TRANSMITTING..." : "AUTHORIZE ADMISSION"}
              </button>
              <div className="flex gap-4">
                <button onClick={() => setShowVerifyModal(false)} className="flex-1 py-5 font-black text-slate-400 uppercase text-[10px]">Cancel</button>
                <button onClick={handleRejectSpecimen} disabled={isProcessing} className="flex-1 py-5 border-2 border-red-50 text-red-500 rounded-3xl font-black uppercase text-[10px] tracking-widest hover:bg-red-50 transition-all active:scale-95 disabled:opacity-50">Reject Specimen</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}