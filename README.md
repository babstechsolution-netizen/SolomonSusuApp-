# Solomon Susu App — Backend API

Awinbire Enterprise Savings Management System. A Node.js/Express REST API for managing susu (savings group) operations including customers, employees, transactions, loans, and reports.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: MongoDB Atlas (via Mongoose)
- **Auth**: JWT (JSON Web Tokens)
- **Password Hashing**: bcryptjs

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/libaski2013/solomonsusuapp.git
cd solomonsusuapp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Long random secret string |
| `JWT_EXPIRES_IN` | Token expiry e.g. `7d` |
| `NODE_ENV` | `development` or `production` |
| `FRONTEND_URL` | Frontend origin for CORS |

### 4. Run the server

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Server runs on `http://localhost:5000` by default.

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Get current user |
| PATCH | `/api/auth/change-password` | Change own password |

### Employees
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List all employees |
| POST | `/api/employees` | Add new employee |
| PATCH | `/api/employees/:id/status` | Suspend or activate employee |

### Customers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/customers` | List all customers |
| POST | `/api/customers` | Register customer |
| PATCH | `/api/customers/:id/assign` | Reassign to employee |

### Transactions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transactions` | List transactions |
| POST | `/api/transactions` | New deposit or withdrawal |
| GET | `/api/transactions/summary` | Today's summary |

### Loans
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/loans` | List all loans |
| POST | `/api/loans` | Create new loan |
| POST | `/api/loans/:id/repay` | Record loan repayment |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Dashboard statistics |
| GET | `/api/dashboard/reports` | Monthly reports |

## Initial Setup (First Deploy)

Seed the first Super Admin by calling this endpoint **once** after deployment:

```
POST /api/auth/seed-admin
```

Default credentials: `admin@awinbire.gh` / `admin123`
**Change the password immediately after first login.**

## Deployment

See [DEPLOY.md](DEPLOY.md) for full instructions on deploying to **Render** with **MongoDB Atlas**.

## License

Private — Awinbire Enterprise. All rights reserved.
