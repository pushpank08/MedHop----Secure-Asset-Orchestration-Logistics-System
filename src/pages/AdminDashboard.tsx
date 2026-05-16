import React, { useState, useEffect } from 'react';

export default function AdminDashboard() {
  const [staff, setStaff] = useState<any[]>([]);
  const [globalLogs, setGlobalLogs] = useState<any>({ missions: [], hub_logs: [], chain_of_custody: [] });
  const [activeTab, setActiveTab] = useState<'STAFF' | 'LOGISTICS' | 'INTELLIGENCE'>('STAFF');
  const [loading, setLoading] = useState(true);

  // Your unique admin identity
  const adminEmail = "pushpankgarg@medhop.com"; 

  const fetchAdminData = async () => {
    setLoading(true);
    try {
      // Fetch Staff Directory
      const staffRes = await fetch(`http://localhost:8000/admin/get-all-staff?admin_email=${adminEmail}`);
      // Fetch Global Logistics Logs
      const logsRes = await fetch(`http://localhost:8000/admin/global-logs?admin_email=${adminEmail}`);
      
      if (staffRes.ok) setStaff(await staffRes.json());
      if (logsRes.ok) setGlobalLogs(await logsRes.json());
    } catch (error) {
      console.error("Admin data fetch failed", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminData();
  }, []);

  const handleUpdateRole = async (email: string, role: string) => {
    const res = await fetch(`http://localhost:8000/admin/update-staff-role?target_email=${email}&new_role=${role}&admin_email=${adminEmail}`, {
      method: 'PUT'
    });
    if (res.ok) fetchAdminData(); // Refresh list after change
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight italic uppercase">
              Pushpank <span className="text-red-600 font-black">Admin Command</span>
            </h1>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Global Network Oversight</p>
          </div>
          <div className="flex bg-white border border-slate-200 p-1 rounded-xl shadow-sm">
            {['STAFF', 'LOGISTICS', 'INTELLIGENCE'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab as any)}
                className={`px-4 py-2 rounded-lg text-[10px] font-black transition-all ${
                  activeTab === tab ? 'bg-red-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </header>

        {/* --- KPI SECTION --- */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <p className="text-slate-400 text-[10px] font-black uppercase mb-1">Staff Directory</p>
            <h2 className="text-2xl font-black text-slate-800">{staff.length}</h2>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <p className="text-slate-400 text-[10px] font-black uppercase mb-1">Global Missions</p>
            <h2 className="text-2xl font-black text-slate-800">{globalLogs.missions.length}</h2>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <p className="text-orange-500 text-[10px] font-black uppercase mb-1">Pending Requests</p>
            <h2 className="text-2xl font-black text-orange-500">
              {staff.filter(s => s.status === 'PENDING').length}
            </h2>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <p className="text-blue-500 text-[10px] font-black uppercase mb-1">Hub Traffic</p>
            <h2 className="text-2xl font-black text-blue-500">{globalLogs.hub_logs.length}</h2>
          </div>
        </div>

        {/* --- STAFF MANAGEMENT TAB --- */}
        {activeTab === 'STAFF' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="font-bold text-slate-700 text-sm">Personnel & Access Rights</h3>
              <button onClick={fetchAdminData} className="text-[10px] font-bold text-blue-600 hover:underline">Refresh List</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50/50">
                  <tr className="text-[10px] text-slate-400 uppercase font-black border-b border-slate-100">
                    <th className="p-4">Staff Email</th>
                    <th className="p-4">Status</th>
                    <th className="p-4">Role Assignment</th>
                    <th className="p-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {staff.map((member) => (
                    <tr key={member.email} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 text-sm font-bold text-slate-700">{member.email}</td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded-md text-[9px] font-black ${
                          member.status === 'PENDING' ? 'bg-orange-100 text-orange-600' : 'bg-green-100 text-green-600'
                        }`}>
                          {member.status}
                        </span>
                      </td>
                      <td className="p-4">
                        <select 
                          className="bg-slate-100 text-[10px] font-bold p-2 rounded-lg border-none"
                          defaultValue={member.preassigned_role}
                          onChange={(e) => handleUpdateRole(member.email, e.target.value)}
                        >
                          <option value="PENDING">PENDING</option>
                          <option value="COORDINATOR">COORDINATOR</option>
                          <option value="COURIER">COURIER</option>
                          <option value="LAB_TECH">LAB_TECH</option>
                          <option value="HUB_OPERATOR">HUB_OPERATOR</option>
                        </select>
                      </td>
                      <td className="p-4 text-right text-slate-400 italic text-[10px]">
                        Last login auto-recorded
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- GLOBAL LOGISTICS TAB --- */}
        {activeTab === 'LOGISTICS' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50 font-bold text-slate-700 text-sm">
              Global Supply Chain History
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-[10px] text-slate-400 font-black uppercase">
                  <tr>
                    <th className="p-4">Item (Qty)</th>
                    <th className="p-4">Route</th>
                    <th className="p-4">Assigned To</th>
                    <th className="p-4">Global Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {globalLogs.missions.map((m: any) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="p-4 font-bold">{m.item_name} <span className="text-slate-400">({m.quantity})</span></td>
                      <td className="p-4 text-xs italic">{m.pickup_location} → {m.dropoff_location}</td>
                      <td className="p-4 text-xs font-mono text-blue-600">{m.assigned_courier || 'NONE'}</td>
                      <td className="p-4">
                        <span className="text-[10px] font-black uppercase bg-slate-100 px-2 py-1 rounded">
                          {m.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}