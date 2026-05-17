# Awinbire Enterprise API — Deploy to Render + MongoDB Atlas

## Step 1 — Create MongoDB Atlas Database (Free Tier)
1. Go to https://cloud.mongodb.com → Sign up or Log in
2. Create a new **Free Cluster** (M0)
3. Under **Database Access** → Add user with username & password (save these)
4. Under **Network Access** → Add IP `0.0.0.0/0` (allow all — required for Render)
5. Click **Connect** → **Drivers** → Copy the connection string:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/awinbire?retryWrites=true&w=majority
   ```

## Step 2 — Push to GitHub
1. Go to https://github.com → New Repository → Name: `awinbire-enterprise-api` → Public → Create
2. In this folder run:
   ```bash
   git init
   git add .
   git commit -m "Initial backend"
   git remote add origin https://github.com/YOUR_USERNAME/awinbire-enterprise-api.git
   git push -u origin main
   ```

## Step 3 — Deploy on Render
1. Go to https://render.com → Sign up (use GitHub)
2. Click **New** → **Web Service** → Connect your `awinbire-enterprise-api` repo
3. Settings:
   - **Name**: awinbire-enterprise-api
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Add **Environment Variables**:
   | Key | Value |
   |-----|-------|
   | `MONGODB_URI` | your Atlas connection string |
   | `JWT_SECRET` | any long random string |
   | `JWT_EXPIRES_IN` | 7d |
   | `NODE_ENV` | production |
   | `FRONTEND_URL` | * |
5. Click **Create Web Service** → Wait ~3 minutes for deploy

## Step 4 — Seed the First Admin
After deploy, call this endpoint **once** to create the Super Admin:
```
POST https://your-app.onrender.com/api/auth/seed-admin
```
Default login: `admin@awinbire.gh` / `admin123`

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Login |
| GET | /api/auth/me | Get current user |
| PATCH | /api/auth/change-password | Change own password |
| GET | /api/employees | List employees |
| POST | /api/employees | Add employee |
| PATCH | /api/employees/:id/status | Suspend/Activate |
| GET | /api/customers | List customers |
| POST | /api/customers | Register customer |
| PATCH | /api/customers/:id/assign | Reassign to employee |
| GET | /api/transactions | List transactions |
| POST | /api/transactions | New deposit/withdrawal |
| GET | /api/transactions/summary | Today's summary |
| GET | /api/loans | List loans |
| POST | /api/loans | Create loan |
| POST | /api/loans/:id/repay | Record repayment |
| GET | /api/dashboard | Dashboard stats |
| GET | /api/dashboard/reports | Monthly reports |
