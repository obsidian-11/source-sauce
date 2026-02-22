# utils/mongo.py
import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

client = MongoClient(os.getenv("MONGO_URI"))
db = client[os.getenv("DB_NAME", "ai_cred_db")]

def get_collection(name="sources"):
    return db[name]
