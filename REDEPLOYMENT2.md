# CLA Online 2 (Prompt Variation) - Production Redeployment Guide

This document provides step-by-step instructions for updating and redeploying the second environment (**https://claonline2.analytx4t.com/** and **https://adminclaonline2.analytx4t.com/**) running on Port **3001** with `promptttt.md`.

---

## Quick Redeployment (Updating Existing Code)

Use these steps whenever you push new changes to GitHub (`priyanshu` branch) and need to update the second live server instance.

### Step 1: Connect to EC2
```bash
ssh -i "path/to/your-key.pem" ubuntu@<YOUR-EC2-PUBLIC-IP>
```

### Step 2: Navigate to Project 2 Directory & Pull Code
```bash
cd /var/www/cla-online2
git pull origin priyanshu
```

### Step 3: Update Backend Dependencies
```bash
npm install
```

### Step 4: Rebuild Admin Dashboard Frontend 2
```bash
cd /var/www/cla-online2/admin-dashboard
npm install
npm run build
cd /var/www/cla-online2
```

### Step 5: Restart Backend Service 2
```bash
pm2 restart cla-backend2
```

### Step 6: Reload Nginx
```bash
sudo systemctl reload nginx
```

### Step 7: Verify Service Status & Logs
```bash
# Check PM2 process table (cla-backend2 should show online)
pm2 status

# View live backend 2 logs
pm2 logs cla-backend2 --lines 50
```

---

## Environment File Cheat Sheet (`/var/www/cla-online2/.env`)

Ensure `/var/www/cla-online2/.env` and `/var/www/cla-online2/backend/.env` contain:

```env
PORT=3001
PROMPT_FILE=promptttt.md
MONGODB_URI=mongodb+srv://<USER>:<PASS>@<CLUSTER>.mongodb.net/cla_legal_chat?retryWrites=true&w=majority
OPENAI_API_KEY=sk-proj-xxxx
SQL_CONN_STR=Driver={ODBC Driver 18 for SQL Server};Server=<SERVER>.database.windows.net,1433;Database=<DB>;Uid=<USER>;Pwd=<PASS>;Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60;
COHERE_API_KEY=xxxx
```

---

## Optional: Updating Embedding Cache for Version 2

If you update vector data in SQL Server or change embedding models for Version 2:

```bash
cd /var/www/cla-online2

# Option A: Copy updated cache from primary project
cp /var/www/cla-online/embedding/embeddings_cache.npz embedding/embeddings_cache.npz

# Option B: Regenerate cache locally for Version 2
rm -f embedding/embeddings_cache.npz
./embedding/venv/bin/python embedding/search_documents.py

# Restart Version 2 backend
pm2 restart cla-backend2
```
