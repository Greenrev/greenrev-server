# GreenRev - Backend API

The core backend server powering the GreenRev automotive ecosystem. Built with Node.js, Express, and MongoDB, this API serves both the Next.js Web Platform and the Flutter Mobile Application. It handles complex multi-tiered Role-Based Access Control (RBAC), real-time WebSocket communication, transaction lifecycle management, and secure authentication.

## Key Features

- **Multi-Tiered RBAC & Authentication**: 
  - JWT-based authentication system supporting multiple roles: `admin`, `vendor`, `mechanic`, and `customer`.
  - Secure password hashing, HTTP-only cookies, and robust route protection middleware.
- **Real-Time Telemetry & Chat (WebSockets)**:
  - Integrated `socket.io` server enabling live, bidirectional communication between clients, vendors, and mechanics.
  - Used for real-time negotiations, support inquiries, and booking confirmations.
- **Dynamic Marketplace Logistics**:
  - Full CRUD operations for High-End Vehicles and Automotive Parts.
  - Acquisition (order) tracking and state management for high-value transactions.
- **Global Expert Network Data**:
  - Provides geo-tagged master technician profiles and availability for map integrations across web and mobile.

## Tech Stack

- **Runtime**: [Node.js](https://nodejs.org/)
- **Framework**: [Express.js](https://expressjs.com/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Database**: [MongoDB](https://www.mongodb.com/) & [Mongoose](https://mongoosejs.com/)
- **Real-Time**: [Socket.io](https://socket.io/)
- **Authentication**: JWT (JSON Web Tokens), bcrypt

## Getting Started

### Prerequisites

Ensure you have Node.js (v18+) and a running instance of MongoDB (local or Atlas) installed.

### Installation

1. Navigate to the server directory:
   ```bash
   cd greenrev-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Create a `.env` file in the root directory:
   ```env
   PORT=4000
   MONGODB_URI=mongodb://localhost:27017/greenrev
   JWT_SECRET=your_super_secret_jwt_key
   CLIENT_URL=http://localhost:3000
   ```

4. Database Seeding (Optional):
   Run the seeding script to populate initial roles and mock data:
   ```bash
   npx ts-node src/scripts/seedRbac.ts
   ```

5. Run the Development Server:
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:4000`.

## Project Structure

- `/src/controllers`: Request handlers for business logic (e.g., `authController.ts`, `productController.ts`).
- `/src/models`: Mongoose database schemas and types.
- `/src/routes`: Express route definitions matching endpoints to controllers.
- `/src/middleware`: Custom middleware for authentication (`requireAuth`), error handling, and file uploads.
- `/src/services`: Encapsulated business logic and external integrations (e.g., `NotificationService`).
- `/src/scripts`: Standalone utilities for database seeding and maintenance.

## License

All rights reserved to GreenRev.
