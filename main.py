import os
import re
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
from supabase import create_client, Client
from datetime import datetime, timezone, timedelta

# 1. SETUP & CONNECTION
load_dotenv()
url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

app = FastAPI()

# 2. UPDATED CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 3. SCHEMAS
class LoginSchema(BaseModel):
    email: str
    password: str

class CreateRequestSchema(BaseModel):
    item_category: str
    pickup_location: str
    dropoff_location: str
    priority: str
    requester_email: str
    accession_id: str
    temperature_req: str
    hazmat_flag: bool
    route_type: str 
    hub_id: Optional[str] = None
    quantity: int = 20 

class HandoffSchema(BaseModel):
    request_id: str
    verifying_email: str  
    new_status: str
    courier_email: str    
    notes: str = ""

class WarpSchema(BaseModel):
    request_id: str
    minutes: int = 90
    warp_biological: bool = True

# --- LIVE INVENTORY ---
@app.get("/get-inventory")
async def get_inventory():
    try:
        res = supabase.table("facility_inventory").select("*").execute()
        return res.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 4. LOGISTICS OPERATIONS
@app.get("/get-courier-tasks")
async def get_courier_tasks():
    try:
        res = supabase.table("logistics_requests").select("*").order("created_at", desc=True).execute()
        tasks = res.data
        for t in tasks:
            if t['status'] not in ['RECEIVED_VERIFIED', 'CANCELLED', 'EXPIRED', 'COMPLETED']:
                created = datetime.fromisoformat(t['created_at'].replace('Z', '+00:00'))
                is_scenario_a = t.get('item_name') in ["Pathology Samples", "Surgical Equipment"]
                is_hub_relay = t.get('route_type') == 'HUB_RELAY'
                base_mins = 240 if (is_scenario_a and is_hub_relay) else 120
                limit_mins = base_mins / 2 if t['priority'] == 'EMERGENCY' else base_mins
                if datetime.now(timezone.utc) > (created + timedelta(minutes=limit_mins)):
                    supabase.table("logistics_requests").update({"status": "EXPIRED"}).eq("id", t['id']).execute()
                    t['status'] = 'EXPIRED'
        return tasks
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/release-assignment")
async def release_assignment(request_id: str, courier_email: str):
    try:
        current_res = supabase.table("logistics_requests").select("status").eq("id", request_id).execute()
        if not current_res.data: raise HTTPException(status_code=404, detail="Mission not found.")
        if current_res.data[0]['status'] != 'ACCEPTED':
            raise HTTPException(status_code=403, detail="Physical pickup already confirmed.")
        supabase.table("logistics_requests").update({"status": "REQUESTED", "assigned_courier": None}).eq("id", request_id).execute()
        supabase.table("chain_of_custody").insert({
            "request_id": request_id, "status": "RELEASED", "actor": courier_email,
            "location": "FIELD_ABANDON", "timestamp": datetime.now(timezone.utc).isoformat()
        }).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/verify-handoff")
async def verify_handoff(data: HandoffSchema):
    try:
        # 1. Fetch current mission state
        current_res = supabase.table("logistics_requests").select("*").eq("id", data.request_id).execute()
        if not current_res.data: 
            raise HTTPException(status_code=404, detail="Request not found.")
        current_req = current_res.data[0]

        # --- MANDATORY DEFINITIONS (Fixes UnboundLocalError) ---
        is_scenario_a = current_req['item_name'] in ["Pathology Samples", "Surgical Equipment"]
        is_return_leg = is_scenario_a and current_req.get('lab_results') is not None

        # 2. STRICT ROLE & LOCATION VALIDATION
        if data.verifying_email and data.courier_email != "LAB_INTAKE_SYSTEM":
            witness_res = supabase.table("staff_directory").select("preassigned_role").eq("email", data.verifying_email).execute()
            if not witness_res.data:
                raise HTTPException(status_code=401, detail=f"Access Denied: {data.verifying_email} is not authorized.")
            
            witness_role = witness_res.data[0]['preassigned_role']

            # RULE: Hub Operations (Check-in OR Outbound Pickup from Hub)
            is_hub_outbound = (
                current_req.get('route_type') == 'HUB_RELAY' and 
                current_req.get('relay_step') in [2, 4] and 
                data.new_status == "PICKED_UP"
            )

            if data.new_status == "AT_CHECKPOINT" or current_req['status'] == "AT_CHECKPOINT" or is_hub_outbound:
                if witness_role != "HUB_MANAGER":
                    raise HTTPException(status_code=403, detail="Handshake Refused: Only a Hub Manager can authorize Hub transitions.")

            # RULE: Initial Pickup (Origin Hospital)
            elif current_req['status'] == "ACCEPTED" and data.new_status == "PICKED_UP" and not is_return_leg:
                if witness_role != "COORDINATOR":
                    raise HTTPException(status_code=403, detail="Handshake Refused: Initial pickups must be verified by a Coordinator.")

            # RULE: Lab Intake (Scenario A Leg 1)
            elif data.new_status == "RECEIVED_VERIFIED" and is_scenario_a and not is_return_leg:
                if witness_role != "LAB_TECH":
                    raise HTTPException(status_code=403, detail="Handshake Refused: Lab intake requires a Lab Technician signature.")

            # RULE: Final Receipts (Return leg or Scenario B)
            elif data.new_status == "RECEIVED_VERIFIED" or (data.new_status == "DELIVERED" and is_return_leg):
                if witness_role != "COORDINATOR":
                    raise HTTPException(status_code=403, detail="Handshake Refused: Final facility receipt requires a Coordinator signature.")

        # --- LOGISTICS & INVENTORY WORKFLOW ---
        transfer_qty = current_req.get('quantity', 20)
        update_payload = {"status": data.new_status, "notes": data.notes}
        custody_location = "FIELD_HANDOVER"
        
        if data.new_status == "DELIVERED" and is_scenario_a and current_req.get('lab_results'):
            update_payload["status"] = "COMPLETED"
            custody_location = "ORIGIN_FACILITY_RECEIPT"
        elif data.new_status == "RECEIVED_VERIFIED" and not is_scenario_a:
            update_payload["status"] = "COMPLETED"
            custody_location = "DESTINATION_FACILITY"
        elif data.new_status == "RECEIVED_VERIFIED" and is_scenario_a and not current_req.get('lab_results'):
            update_payload["status"] = "PROCESSING"
            update_payload["assigned_courier"] = None
            custody_location = "CLINICAL_LAB_INTAKE"

        # Inventory Math
        if data.new_status == "PICKED_UP" and current_req['status'] == "ACCEPTED":
            supabase.rpc('deduct_inventory', {'f_name': current_req['pickup_location'], 'i_name': current_req['item_name'], 'qty': transfer_qty}).execute()

        is_critical_med = current_req.get('item_name') == "Critical Medicines"
        current_final_status = update_payload.get("status")
        should_add_inventory = ((is_critical_med and current_final_status in ["COMPLETED", "PROCESSING"]) or (not is_critical_med and current_final_status == "COMPLETED"))
        if should_add_inventory:
            supabase.rpc('add_inventory', {'f_name': current_req['dropoff_location'], 'i_name': current_req['item_name'], 'qty': transfer_qty}).execute()

        # --- HUB RELAY LOGIC (WITH AUDIT TRAIL) ---
        if data.new_status == "AT_CHECKPOINT":
            update_payload.update({"assigned_courier": None, "status": "REQUESTED", "relay_step": current_req.get('relay_step', 1) + 1, "current_location": "TRANSIT_HUB", "created_at": datetime.now(timezone.utc).isoformat()})
            hub_id = current_req.get('hub_id')
            if hub_id:
                hub_res = supabase.table("locations").select("name").eq("id", hub_id).execute()
                if hub_res.data: update_payload["pickup_location"] = hub_res.data[0]['name']
            
            custody_location = "TRANSIT_HUB"
            drawer_match = re.search(r"\(([^)]+)\)", data.notes)
            storage_slot = drawer_match.group(1) if drawer_match else "Stabilization Vault"
            supabase.table("hub_storage_logs").insert({"request_id": data.request_id, "accession_id": current_req['accession_id'], "item_name": current_req['item_name'], "inbound_courier": data.courier_email, "storage_slot": storage_slot, "check_in_time": datetime.now(timezone.utc).isoformat(), "status": "IN_STORAGE"}).execute()
            
            # Explicit Hub Audit log
            supabase.table("chain_of_custody").insert({"request_id": data.request_id, "status": "AT_CHECKPOINT", "actor": data.courier_email, "location": "TRANSIT_HUB", "notes": f"Verified by HUB_MANAGER. Witness:{data.verifying_email}. {data.notes}", "recorded_quantity": transfer_qty, "timestamp": datetime.now(timezone.utc).isoformat()}).execute()
        
        elif data.new_status == "PICKED_UP" and current_req.get('route_type') == 'HUB_RELAY' and current_req.get('relay_step') in [2, 4]:
            update_payload.update({"assigned_courier": data.courier_email, "current_location": "IN_TRANSIT"})
            custody_location = "IN_TRANSIT"
            supabase.table("hub_storage_logs").update({"outbound_courier": data.courier_email, "check_out_time": datetime.now(timezone.utc).isoformat(), "status": "RELEASED"}).eq("request_id", data.request_id).eq("status", "IN_STORAGE").execute()
        else:
            if data.courier_email not in ["COORDINATOR", "LAB_INTAKE_SYSTEM"]: update_payload["assigned_courier"] = data.courier_email
            location_map = {"PICKED_UP": "IN_TRANSIT", "DELIVERED": "RECEIVING_DOCK", "RECEIVED_VERIFIED": "FACILITY_INTAKE", "CANCELLED": "TERMINATED"}
            update_payload["current_location"] = location_map.get(data.new_status, "IN_TRANSIT")
            custody_location = update_payload["current_location"]

        # Final Update
        supabase.table("logistics_requests").update(update_payload).eq("id", data.request_id).execute()

        # Final Audit Logging
        if data.new_status != "AT_CHECKPOINT":
            final_status = update_payload.get("status", data.new_status)
            supabase.table("chain_of_custody").insert({
                "request_id": data.request_id, "status": final_status, 
                "actor": data.courier_email if data.courier_email != "LAB_INTAKE_SYSTEM" else data.verifying_email,
                "location": custody_location, "notes": f"Verified by Staff. Witness:{data.verifying_email}. {data.notes}",
                "recorded_quantity": transfer_qty, "timestamp": datetime.now(timezone.utc).isoformat()
            }).execute()

        return {"status": "success"}
    except HTTPException as he: raise he
    except Exception as e: raise HTTPException(status_code=400, detail=str(e))

@app.post("/submit-lab-result")
async def submit_result(request_id: str, result_data: str, technician_email: str):
    try:
        curr_res = supabase.table("logistics_requests").select("*").eq("id", request_id).single().execute()
        curr = curr_res.data
        update_payload = {"status": "REQUESTED", "lab_results": result_data, "assigned_courier": None, "current_location": curr['dropoff_location']}

        if curr.get('route_type') == 'HUB_RELAY':
            hub_res = supabase.table("locations").select("name").eq("id", curr['hub_id']).single().execute().data
            update_payload.update({"pickup_location": curr['dropoff_location'], "dropoff_location": hub_res['name'], "relay_step": 3})
        else:
            update_payload.update({"pickup_location": curr['dropoff_location'], "dropoff_location": curr['pickup_location'], "relay_step": 0})

        supabase.table("logistics_requests").update(update_payload).eq("id", request_id).execute()
        supabase.table("chain_of_custody").insert({"request_id": request_id, "status": "RESULT_PUBLISHED", "actor": technician_email, "location": "PROCESS_FACILITY", "notes": "Analysis complete. Return authorized.", "recorded_quantity": curr.get('quantity', 20), "timestamp": datetime.now(timezone.utc).isoformat()}).execute()
        return {"status": "success"}
    except Exception as e: raise HTTPException(status_code=400, detail=str(e))

@app.get("/get-hub-logs")
async def get_hub_logs():
    return supabase.table("hub_storage_logs").select("*").order("check_in_time", desc=True).execute().data

@app.put("/simulate-sla-risk")
async def simulate_sla_risk(data: WarpSchema):
    warped_time = (datetime.now(timezone.utc) - timedelta(minutes=data.minutes)).isoformat()
    supabase.table("logistics_requests").update({"created_at": warped_time, "mission_start_time": warped_time}).eq("id", data.request_id).execute()
    return {"status": "success"}

@app.get("/get-timeline")
async def get_timeline(request_id: str = Query(...)):
    res = supabase.table("chain_of_custody").select("*").eq("request_id", request_id).order("timestamp", desc=False).execute()
    return res.data

@app.post("/create-request")
async def create_request(data: CreateRequestSchema):
    now_time = datetime.now(timezone.utc).isoformat()
    res = supabase.table("logistics_requests").insert({"item_name": data.item_category, "pickup_location": data.pickup_location, "dropoff_location": data.dropoff_location, "priority": data.priority, "requester_email": data.requester_email, "status": "REQUESTED", "accession_id": data.accession_id, "temperature_req": data.temperature_req, "hazmat_flag": data.hazmat_flag, "current_location": data.pickup_location, "route_type": data.route_type, "hub_id": data.hub_id, "quantity": data.quantity, "mission_start_time": now_time, "relay_step": 1 if data.route_type == "HUB_RELAY" else 0}).execute()
    if res.data:
        supabase.table("chain_of_custody").insert({"request_id": res.data[0]['id'], "status": "REQUESTED", "actor": data.requester_email, "location": "ORIGIN_FACILITY", "notes": f"Authorized. Qty: {data.quantity}", "recorded_quantity": data.quantity, "timestamp": now_time}).execute()
    return {"status": "success"}

@app.get("/verify-lis")
async def verify_lis(accession_id: str = Query(...)):
    res = supabase.table("patients").select("*").ilike("accession_id", accession_id.strip()).execute()
    if res.data: return {"valid": True, "patient": res.data[0]['patient_name']}
    return {"valid": False, "message": "Accession ID not found"}

@app.get("/get-coordinator-requests")
async def get_requests(email: str = Query(...)):
    return supabase.table("logistics_requests").select("*").eq("requester_email", email).order("created_at", desc=True).execute().data

@app.get("/get-locations")
async def get_locations():
    return supabase.table("locations").select("*").execute().data

@app.post("/login")
async def login(data: LoginSchema):
    res = supabase.table("staff_directory").select("*").eq("email", data.email).execute()
    if not res.data: return {"status": "pending_approval", "user": {"email": data.email, "role": "PENDING", "name": "New Applicant"}}
    user = res.data[0]
    if "password" in user and user['password'] != data.password: raise HTTPException(status_code=401, detail="Invalid password")
    return {"status": "success", "user": {"email": user['email'], "role": user['preassigned_role'], "name": user.get('name') or user['email'].split('@')[0].capitalize()}}