import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import medhopLogo from '../assets/logo.png'; 

export default function Login() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    const API_URL = "http://localhost:8000"; 
    // If not login, we still hit the login endpoint to check for 'PENDING' status 
    // unless you specifically implement a separate /signup logic later.
    const endpoint = isLogin ? "/login" : "/login"; 

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      // Handle successful authentication OR the 'pending_approval' status from our backend
      if (response.ok || data.status === 'pending_approval') {
        const userObj = data.user;
        const role = userObj?.role?.toUpperCase();
        
        // Save session data
        localStorage.setItem('user_email', userObj.email);
        localStorage.setItem('user_name', userObj.name);

        if (isLogin) {
          // Role-based Navigation for Login
          if (role === 'ADMIN') {
            navigate('/admin');
          } else if (role === 'COORDINATOR') {
            navigate('/coordinator');
          } else if (role === 'COURIER') {
            navigate('/courier');
          } else if (role === 'LAB_TECH') {
            navigate('/lab-dashboard');
          } else if (role === 'HUB_MANAGER') {
            // Updated to navigate correctly based on your HUB_MANAGER database entry
            navigate('/hub-dashboard');
          } else {
            navigate('/pending');
          }
        } else {
          // If the user was trying to Register, send them to Pending immediately
          navigate('/pending');
        }
      } else {
        alert(data.detail || "Authentication failed. Check your Staff Directory entry.");
      }
    } catch (err) {
      alert("Connection Error: Is the Python Backend running on port 8000?");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f2faf2] px-4">
      <div className="max-w-xs w-full bg-white p-6 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-green-100">
        
        <div className="flex flex-col items-center mb-5">
          <img 
            src={medhopLogo} 
            alt="MedHop Logo" 
            className="w-20 h-20 object-contain mb-1" 
          />
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">
            Med<span className="text-[#4CAF50]">Hop</span>
          </h1>
          <p className="text-slate-400 text-[10px] font-medium tracking-wide uppercase">
            {isLogin ? 'Internal Logistics Portal' : 'Staff Registration'}
          </p>
        </div>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="text-left">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider ml-1">
              Email Address
            </label>
            <input 
              type="email" 
              placeholder="name@medhop.in" 
              className="w-full p-2.5 mt-1 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500 transition-all"
              onChange={(e) => setEmail(e.target.value)}
              value={email}
              required
            />
          </div>

          <div className="text-left">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider ml-1">
              Password
            </label>
            <input 
              type="password" 
              placeholder="••••••••" 
              className="w-full p-2.5 mt-1 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500 transition-all"
              onChange={(e) => setPassword(e.target.value)}
              value={password}
              required
            />
          </div>

          <button 
            type="submit" 
            disabled={isLoading}
            className={`w-full bg-[#4CAF50] text-white py-2.5 rounded-lg text-sm font-semibold shadow-sm transition-all mt-2 ${
              isLoading ? 'opacity-70 cursor-not-allowed' : 'hover:bg-[#43a047] active:scale-95'
            }`}
          >
            {isLoading ? 'Processing...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-[11px] text-slate-500">
            {isLogin ? "New staff member?" : "Already have an account?"}{' '}
            <button 
              type="button"
              onClick={() => setIsLogin(!isLogin)}
              className="text-[#4CAF50] font-bold hover:underline cursor-pointer"
            >
              {isLogin ? 'Register here' : 'Login instead'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}