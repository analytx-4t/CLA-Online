# CLA Online - Production Deployment & Redeployment Guide

This document provides step-by-step instructions for updating an existing production server, as well as setting up a fresh AWS EC2 instance from scratch.

---

## Part 1: Quick Redeployment (Updating Existing Code)

Use these steps whenever you push new changes to GitHub (`main` or `priyanshu` branch) and need to deploy them to the live server.

### Step 1: Connect to EC2
```bash
ssh -i "path/to/your-key.pem" ubuntu@<YOUR-EC2-PUBLIC-IP>
```

### Step 2: Navigate & Pull Latest Code
```bash
cd /var/www/cla-online
git pull origin priyanshu   # Or 'main', depending on target branch
```

### Step 3: Update Backend Dependencies (If modified)
```bash
npm install
```

### Step 4: Rebuild Admin Dashboard Frontend
```bash
cd /var/www/cla-online/admin-dashboard
npm install
npm run build
cd /var/www/cla-online
```

### Step 5: Restart the Backend Service
```bash
pm2 restart cla-backend
```

### Step 6: Verify Deployment
```bash
# Check PM2 status
pm2 status

# View live backend logs
pm2 logs cla-backend --lines 50
```

---

## Part 2: Updating Embedding Cache (Optional)

If you updated vector data in SQL Server or changed embedding models:

```bash
cd /var/www/cla-online

# Delete old cache file
rm -f embedding/embeddings_cache.npz

# Regenerate cache from SQL database (shows live progress)
./embedding/venv/bin/python embedding/search_documents.py

# Restart backend after completion
pm2 restart cla-backend
```

---

## Part 3: Fresh Server Setup Guide (Full Deployment)

If setting up a brand-new EC2 Ubuntu instance (Ubuntu 24.04 / 26.04):

### Recommended EC2 Specifications
* **Instance Type**: `t3.large` or `t3.xlarge` (minimum 8 GB RAM recommended for processing 50k+ vector chunks)
* **OS**: Ubuntu Server 24.04 LTS (Noble) or 26.04 LTS
* **Storage**: 30+ GB SSD (gp3)
* **Security Group Rules**:
  * Port `22` (SSH)
  * Port `80` (HTTP)
  * Port `443` (HTTPS)

---

### Step 1: System Package Updates & Tools
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git unzip build-essential nginx certbot python3-certbot-nginx
```

---

### Step 2: Install Node.js (v20 LTS)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

---

### Step 3: Install Microsoft ODBC Driver 18 (For SQL Server Connectivity)
```bash
# Import Microsoft repository signing key
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | sudo gpg --dearmor --overwrite -o /usr/share/keyrings/microsoft-prod.gpg

# Register Ubuntu Noble (24.04) repository pool for msodbcsql18
curl -fsSL "https://packages.microsoft.com/config/ubuntu/24.04/prod.list" | sudo tee /etc/apt/sources.list.d/msprod.list

sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18 mssql-tools18 unixodbc-dev
```

---

### Step 4: Clone Repository & Setup Permissions
```bash
sudo mkdir -p /var/www/cla-online
sudo chown -R ubuntu:ubuntu /var/www/cla-online

git clone https://github.com/analytx-4t/CLA-Online.git /var/www/cla-online
cd /var/www/cla-online
```

---

### Step 5: Configure Environment Variables (`.env`)
Create `/var/www/cla-online/.env` or `/var/www/cla-online/backend/.env`:

```env
PORT=3000
MONGODB_URI=mongodb+srv://<USER>:<PASS>@<CLUSTER>.mongodb.net/<DB>?retryWrites=true&w=majority
OPENAI_API_KEY=sk-proj-xxxx
SQL_CONN_STR=Driver={ODBC Driver 18 for SQL Server};Server=<SERVER>.database.windows.net,1433;Database=<DB>;Uid=<USER>;Pwd=<PASS>;Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60;
COHERE_API_KEY=xxxx
```

---

### Step 6: Install Backend Dependencies & Python Venv
```bash
# Node dependencies
cd /var/www/cla-online
npm install

# Setup Python Virtual Environment for Embeddings
sudo apt-get install -y python3-venv python3-pip
python3 -m venv embedding/venv
./embedding/venv/bin/pip install --upgrade pip
./embedding/venv/bin/pip install -r embedding/requirements.txt
```

---

### Step 7: Build Admin Dashboard
```bash
cd /var/www/cla-online/admin-dashboard
npm install
npm run build
```

---

### Step 8: Configure Nginx Reverse Proxy & SSL

Create `/etc/nginx/sites-available/cla-online`:

```nginx
server {
    server_name claonline.analytx4t.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}

server {
    server_name adminclaonline.analytx4t.com;

    # Admin Panel Static Build
    location / {
        root /var/www/cla-online/admin-dashboard/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Proxy API & WebSockets to Backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

Enable site & test configuration:
```bash
sudo ln -s /etc/nginx/sites-available/cla-online /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Obtain SSL certificates with Certbot:
```bash
sudo certbot --nginx -d claonline.analytx4t.com -d adminclaonline.analytx4t.com
```

---

### Step 9: Start Application with PM2
```bash
cd /var/www/cla-online
pm2 start backend/index.js --name "cla-backend"
pm2 save
pm2 startup
```

---

## Troubleshooting Cheat Sheet

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **`Can't open lib 'ODBC Driver 18'`** | Missing Microsoft ODBC driver on Linux | Run Step 3 from Fresh Server Setup. |
| **`504 Gateway Time-out`** | Nginx default timeout (60s) reached during initial search/cache load | Ensure `proxy_read_timeout 300s;` is present in Nginx config. |
| **`ERR_CONNECTION_REFUSED` in Admin Panel** | Hardcoded `http://127.0.0.1:3000` in frontend build | Ensure latest code is pulled and `npm run build` is run inside `admin-dashboard`. |
| **Search returns slow or missing results** | Local embedding cache corrupted or incomplete | Delete `embedding/embeddings_cache.npz` and run `search_documents.py`. |
