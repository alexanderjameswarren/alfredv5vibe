# Warren Buffet — progress

Money tracking from SimpleFIN Bridge into Supabase. The local probe lives in `tools/warren-buffet/`.

## Step 1 (2026-10-04), plan
- Chose `tools/warren-buffet/` over `workshop/scripts/`, so the financial secret never shares the Workshop `.env`.

## Step 2 (2026-10-04), local folder
- `tools/warren-buffet/.gitignore`: `.env`, `.venv/`, `__pycache__/`, `*.pyc`.
- `tools/warren-buffet/.env`: placeholder `SIMPLEFIN_ACCESS_URL=` only, and ignored. Alex pastes the value himself.
- `tools/warren-buffet/.env.example`: the same placeholder, committed.
- `tools/warren-buffet/requirements.txt`: `requests==2.34.2`, `python-dotenv==1.2.2`.
- `tools/warren-buffet/.venv`: created with Python 3.12.10 and requirements installed. Ignored.
- Root `.gitignore`: added `.env` as a repo-wide safety net.
- Verified with `git check-ignore -v`: `.env` and `.venv` are both matched by `tools/warren-buffet/.gitignore`.
- `simplefin_hello.py`: Alex added it; `from dotenv import load_dotenv` / `load_dotenv()` now follow the imports.
- The script writes `simplefin_raw.json` (full account data) to the current directory, so it was added to `tools/warren-buffet/.gitignore`. Always run the script from inside the folder:
  - First run: `Push-Location tools\warren-buffet; .\.venv\Scripts\python.exe simplefin_hello.py <SETUP_TOKEN>; Pop-Location`
  - Later runs: `Push-Location tools\warren-buffet; .\.venv\Scripts\python.exe simplefin_hello.py; Pop-Location`
