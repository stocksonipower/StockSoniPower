"""One-time admin script: clears all STRs, STNs, and their stock transactions."""
import asyncio
from pathlib import Path
from dotenv import load_dotenv
import os
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv(Path(__file__).parent / ".env")


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    str_count = await db.transfer_requests.count_documents({})
    stn_count = await db.transfer_notes.count_documents({})
    txn_count = await db.transactions.count_documents({"transfer_note_id": {"$exists": True}})
    ctr_count = await db.counters.count_documents({"_id": {"$regex": "^(str|stn):"}})

    print("=== Records to be deleted ===")
    print(f"  transfer_requests:  {str_count}")
    print(f"  transfer_notes:     {stn_count}")
    print(f"  transactions (STN): {txn_count}")
    print(f"  counters (str/stn): {ctr_count}")
    print()

    confirm = input("Type YES to proceed with deletion: ").strip()
    if confirm != "YES":
        print("Aborted.")
        return

    r1 = await db.transactions.delete_many({"transfer_note_id": {"$exists": True}})
    r2 = await db.transfer_notes.delete_many({})
    r3 = await db.transfer_requests.delete_many({})
    r4 = await db.counters.delete_many({"_id": {"$regex": "^(str|stn):"}})

    print("=== Deleted ===")
    print(f"  transactions:       {r1.deleted_count}")
    print(f"  transfer_notes:     {r2.deleted_count}")
    print(f"  transfer_requests:  {r3.deleted_count}")
    print(f"  counters:           {r4.deleted_count}")
    print("Done. STR/STN numbering will restart at 001 on the next entry.")


asyncio.run(main())
