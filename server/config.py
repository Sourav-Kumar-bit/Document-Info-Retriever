import os

from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings

load_dotenv()


def get_env_variable(var_name: str, default: str | None = None) -> str:
    value = os.getenv(var_name, default)
    if value is None or value == "":
        raise RuntimeError(f"{var_name} not found. Check your .env file.")
    return value


API_KEY = get_env_variable("GEMINI_API_KEY")

DB_CONFIG = {
    "host": get_env_variable("DB_HOST"),
    "port": int(get_env_variable("DB_PORT", "5432")),
    "dbname": get_env_variable("DB_NAME", "postgres"),
    "user": get_env_variable("DB_USER", "postgres"),
    "password": get_env_variable("DB_PASSWORD"),
}

ALLOWED_ORIGINS = [
    o.strip()
    for o in get_env_variable("ALLOWED_ORIGINS", "http://localhost:4200").split(",")
    if o.strip()
]

MAX_DOCS_PER_SESSION = int(get_env_variable("MAX_DOCS_PER_SESSION", "5"))

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
EMBED_DIM = 768

document_embeddings = GoogleGenerativeAIEmbeddings(
    model="gemini-embedding-001", api_key=API_KEY,
    task_type="retrieval_document", output_dimensionality=EMBED_DIM,
)

query_embeddings = GoogleGenerativeAIEmbeddings(
    model="gemini-embedding-001", api_key=API_KEY,
    task_type="retrieval_query", output_dimensionality=EMBED_DIM,
)

llm = ChatGoogleGenerativeAI(
    model="gemini-3.5-flash", api_key=API_KEY, temperature=0
)
