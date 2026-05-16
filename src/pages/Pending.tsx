export default function Pending() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f2faf2] px-4">
      <div className="max-w-sm w-full bg-white p-8 rounded-2xl shadow-sm border border-orange-100 text-center">
        <div className="text-4xl mb-4">⏳</div>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">Approval Pending</h1>
        <p className="text-slate-500 text-sm leading-relaxed mb-6">
          Your account is not yet active in the **Staff Directory**. Please contact your administrator to authorize your role.
        </p>
        <button 
          onClick={() => window.location.href = '/'}
          className="w-full text-[#4CAF50] font-bold text-sm hover:underline"
        >
          Back to Login
        </button>
      </div>
    </div>
  );
}