MedHop | Secure Asset Orchestration & Logistics System
MedHop is a mission-critical medical logistics platform engineered to manage the end-to-end lifecycle of high-stakes transfers, such as pathology samples and critical medicines. The system focuses on data integrity, role-based security, and verifiable chain of custody.

🏗️ System Architecture
The platform is built on a modern, distributed stack designed for high-availability and real-time synchronization:

Frontend: React 18, TypeScript, Vite

Styling: Tailwind CSS, Lucide React

Geospatial: Leaflet.js / OpenStreetMap (OSM) for real-time routing

Backend: FastAPI (Python), Uvicorn, Pydantic

Database: Supabase (PostgreSQL)

Business Logic: PostgreSQL RPCs (Stored Procedures) for atomic transactions

🛡️ Key Engineering Features
1. Role-Based Access Control (RBAC)
Implemented 5 distinct, conditional dashboards (Admin, Coordinator, Manager, Courier, Lab Technician) with strict data isolation. Sensitive clinical information is only visible to authorized roles.

2. Atomic Inventory Engine
Used PostgreSQL RPCs to handle inventory reconciliation. This ensures that package handovers (add/deduct) are atomic transactions, preventing data discrepancies or "ghost" inventory during physical transfers.

3. Security Handshake & Chain of Custody
Established a tamper-proof audit trail through a multi-witness handshake protocol. Every pickup and delivery requires a verified email handshake from an authorized witness, recorded in the permanent mission history.

4. Geospatial Decision Engine
Integrated real-time distance metrics to automate logistics routing. The system dynamically suggests a Direct Sprint for short distances or a Hub Relay (for stabilization) for long-haul transfers.

5. SLA Biological Clock
Built a real-time monitoring system that tracks the viability window of clinical samples. The system triggers visual alerts and status updates as the mission approaches its SLA deadline.

🚀 Local Setup
Backend
Navigate to the backend folder: cd backend

Create a virtual environment: python -m venv venv

Install dependencies: pip install -r requirements.txt

Create a .env file with your SUPABASE_URL and SUPABASE_KEY.

Start the server: uvicorn main:app --reload

Frontend
Navigate to the frontend folder: cd frontend

Install dependencies: npm install

Start the development server: npm run dev

📄 License
This project is for academic and portfolio purposes. All rights reserved.
