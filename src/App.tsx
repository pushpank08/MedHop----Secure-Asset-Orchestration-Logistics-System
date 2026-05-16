import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import AdminDashboard from './pages/AdminDashboard';
import CoordinatorDashboard from './pages/CoordinatorDashboard';
import CourierDashboard from './pages/CourierDashboard';
import LabTechnicianDashboard from './pages/LabTechnicianDashboard'; 
import HubDashboard from './pages/HubDashboard'; // Added Import for Scenario B
import Pending from './pages/Pending';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/coordinator" element={<CoordinatorDashboard />} />
        <Route path="/courier" element={<CourierDashboard />} />
        <Route path="/lab-dashboard" element={<LabTechnicianDashboard />} /> 
        <Route path="/hub-dashboard" element={<HubDashboard />} /> {/* Added Route for Hub Manager */}
        <Route path="/pending" element={<Pending />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

export default App;