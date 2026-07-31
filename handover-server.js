/**
 * handover-server.js
 * LSP Lab Shift Handover Tool — Backend
 * Stack: Node.js + Express + PostgreSQL (Supabase via DATABASE_URL)
 * Deploy: Render (set DATABASE_URL env var in Render dashboard)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const path    = require('path');
const EQUIPMENT = require('./equipment.js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Database ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required for Supabase / Render
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS handover_reports (
      id            SERIAL PRIMARY KEY,
      shift_date    DATE        NOT NULL,
      shift_type    VARCHAR(10) NOT NULL,  -- 'Day' | 'Night'
      supervisor    VARCHAR(100),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      general_notes TEXT,
      safety_notes  TEXT,
      submitted     BOOLEAN     DEFAULT FALSE,
      UNIQUE (shift_date, shift_type)
    );

    CREATE TABLE IF NOT EXISTS equipment_status (
      id           SERIAL PRIMARY KEY,
      report_id    INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      equip_code   VARCHAR(30)  NOT NULL,
      equip_name   VARCHAR(200) NOT NULL,
      owner        VARCHAR(10)  NOT NULL,
      status       VARCHAR(20)  NOT NULL DEFAULT 'Normal',  -- Normal | Issue | OOS | Standby
      remarks      TEXT,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (report_id, equip_code)
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id          SERIAL PRIMARY KEY,
      report_id   INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      description TEXT        NOT NULL,
      priority    VARCHAR(10) DEFAULT 'Normal',  -- High | Normal | Low
      assigned_to VARCHAR(100),
      status      VARCHAR(20) DEFAULT 'Open',    -- Open | In Progress | Closed
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅  Database tables ready');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'handover.html')));

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /api/equipment — full equipment master list */
app.get('/api/equipment', (_req, res) => {
  res.json(EQUIPMENT);
});

/** GET /api/reports?limit=30 — list recent reports (summary) */
app.get('/api/reports', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const { rows } = await pool.query(
      `SELECT id, shift_date, shift_type, supervisor, submitted, created_at, updated_at
       FROM handover_reports
       ORDER BY shift_date DESC, shift_type DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/reports/:id — full report with equipment_status + action_items */
app.get('/api/reports/:id', async (req, res) => {
  try {
    const { rows: [report] } = await pool.query(
      'SELECT * FROM handover_reports WHERE id = $1', [req.params.id]
    );
    if (!report) return res.status(404).json({ error: 'Not found' });

    const { rows: equip } = await pool.query(
      'SELECT * FROM equipment_status WHERE report_id = $1 ORDER BY owner, equip_code',
      [req.params.id]
    );
    const { rows: actions } = await pool.query(
      'SELECT * FROM action_items WHERE report_id = $1 ORDER BY id',
      [req.params.id]
    );
    res.json({ ...report, equipment: equip, actions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/reports/by-shift?date=YYYY-MM-DD&shift=Day|Night */
app.get('/api/reports/by-shift', async (req, res) => {
  try {
    const { date, shift } = req.query;
    const { rows: [report] } = await pool.query(
      'SELECT * FROM handover_reports WHERE shift_date=$1 AND shift_type=$2',
      [date, shift]
    );
    if (!report) return res.json(null);

    const { rows: equip } = await pool.query(
      'SELECT * FROM equipment_status WHERE report_id = $1 ORDER BY owner, equip_code',
      [report.id]
    );
    const { rows: actions } = await pool.query(
      'SELECT * FROM action_items WHERE report_id = $1 ORDER BY id',
      [report.id]
    );
    res.json({ ...report, equipment: equip, actions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/reports — create or update a report (upsert by date+shift) */
app.post('/api/reports', async (req, res) => {
  const { shift_date, shift_type, supervisor, general_notes, safety_notes } = req.body;
  try {
    const { rows: [report] } = await pool.query(
      `INSERT INTO handover_reports (shift_date, shift_type, supervisor, general_notes, safety_notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (shift_date, shift_type)
       DO UPDATE SET supervisor=$3, general_notes=$4, safety_notes=$5, updated_at=NOW()
       RETURNING *`,
      [shift_date, shift_type, supervisor, general_notes, safety_notes]
    );
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/reports/:id/submit — mark report as submitted */
app.patch('/api/reports/:id/submit', async (req, res) => {
  try {
    const { rows: [report] } = await pool.query(
      `UPDATE handover_reports SET submitted=TRUE, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!report) return res.status(404).json({ error: 'Not found' });
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/reports/:id/equipment — bulk upsert equipment status rows */
app.put('/api/reports/:id/equipment', async (req, res) => {
  // body: [ { equip_code, equip_name, owner, status, remarks }, ... ]
  const reportId = req.params.id;
  const items = req.body;
  try {
    for (const item of items) {
      await pool.query(
        `INSERT INTO equipment_status (report_id, equip_code, equip_name, owner, status, remarks, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (report_id, equip_code)
         DO UPDATE SET status=$5, remarks=$6, updated_at=NOW()`,
        [reportId, item.equip_code, item.equip_name, item.owner, item.status, item.remarks || '']
      );
    }
    const { rows } = await pool.query(
      'SELECT * FROM equipment_status WHERE report_id=$1 ORDER BY owner, equip_code',
      [reportId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/reports/:id/actions — add action item */
app.post('/api/reports/:id/actions', async (req, res) => {
  const { description, priority, assigned_to } = req.body;
  try {
    const { rows: [action] } = await pool.query(
      `INSERT INTO action_items (report_id, description, priority, assigned_to)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, description, priority || 'Normal', assigned_to || '']
    );
    res.json(action);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/actions/:id — update action item status/fields */
app.patch('/api/actions/:id', async (req, res) => {
  const { status, description, priority, assigned_to } = req.body;
  try {
    const { rows: [action] } = await pool.query(
      `UPDATE action_items
       SET status=COALESCE($1,status),
           description=COALESCE($2,description),
           priority=COALESCE($3,priority),
           assigned_to=COALESCE($4,assigned_to)
       WHERE id=$5 RETURNING *`,
      [status, description, priority, assigned_to, req.params.id]
    );
    if (!action) return res.status(404).json({ error: 'Not found' });
    res.json(action);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/actions/:id */
app.delete('/api/actions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM action_items WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/health */
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'db error', error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀  Handover server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌  DB init failed:', err.message);
    process.exit(1);
  });
