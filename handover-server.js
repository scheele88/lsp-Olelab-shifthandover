'use strict';
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const path     = require('path');
const EQUIPMENT = require('./equipment.js');

const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ATTACHMENT_BUCKET = 'handover-attachments';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

const app  = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  // Create tables if they don't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS handover_reports (
      id                   SERIAL PRIMARY KEY,
      shift_date           DATE        NOT NULL,
      shift_type           VARCHAR(10) NOT NULL,
      logged_by            VARCHAR(50),
      current_shift_team   VARCHAR(5),
      current_supervisor   VARCHAR(100),
      handover_shift_team  VARCHAR(5),
      handover_supervisor  VARCHAR(100),
      pending_samples_note TEXT,
      lims_issues          TEXT,
      general_remarks      TEXT,
      outgoing_name        VARCHAR(50),
      outgoing_ts          TIMESTAMPTZ,
      incoming_name        VARCHAR(50),
      incoming_ts          TIMESTAMPTZ,
      locked               BOOLEAN DEFAULT FALSE,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (shift_date, shift_type)
    );
    CREATE TABLE IF NOT EXISTS equip_trouble (
      id             SERIAL PRIMARY KEY,
      report_id      INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      equip_code     VARCHAR(30),
      equip_name     VARCHAR(200),
      owner          VARCHAR(20),
      issue_type     VARCHAR(50),
      issue_other    TEXT,
      details        TEXT,
      root_cause     TEXT,
      action_taken   TEXT,
      out_of_service VARCHAR(5) DEFAULT 'No',
      status         VARCHAR(20) DEFAULT 'Investigating',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_samples (
      id            SERIAL PRIMARY KEY,
      report_id     INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      sample_point  VARCHAR(200),
      reason        TEXT,
      action_needed TEXT,
      sort_order    INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS schedule_changes (
      id             SERIAL PRIMARY KEY,
      report_id      INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      plant          VARCHAR(20),
      change_desc    TEXT,
      effective_date DATE,
      requested_by   VARCHAR(100),
      sort_order     INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS requested_samples (
      id             SERIAL PRIMARY KEY,
      report_id      INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      plant          VARCHAR(20),
      product_stream VARCHAR(200),
      test_items     TEXT,
      requested_by   VARCHAR(100),
      target_date    DATE,
      priority       VARCHAR(10) DEFAULT 'Normal',
      sort_order     INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS import_export (
      id              SERIAL PRIMARY KEY,
      report_id       INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      direction       VARCHAR(10)  NOT NULL DEFAULT 'Import',
      material        VARCHAR(200) NOT NULL DEFAULT '',
      etb             DATE,
      num_tanks       VARCHAR(50),
      num_samples     VARCHAR(50),
      status          VARCHAR(20)  DEFAULT 'Initial',
      quality         VARCHAR(20),
      remark          TEXT,
      sort_order      INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lims_issues (
      id          SERIAL PRIMARY KEY,
      report_id   INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      description TEXT,
      sort_order  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS general_remarks (
      id          SERIAL PRIMARY KEY,
      report_id   INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      description TEXT,
      sort_order  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id            SERIAL PRIMARY KEY,
      report_id     INTEGER REFERENCES handover_reports(id) ON DELETE CASCADE,
      section       VARCHAR(20) NOT NULL,
      row_id        INTEGER NOT NULL,
      file_name     VARCHAR(255),
      file_url      TEXT,
      storage_path  TEXT,
      uploaded_by   VARCHAR(50),
      uploaded_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migration: add missing columns to existing handover_reports table (safe — IF NOT EXISTS)
  const migrations = [
    `ALTER TABLE pending_samples ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'In-progress'`,
    `ALTER TABLE equip_trouble ADD COLUMN IF NOT EXISTS start_date DATE`,
    `ALTER TABLE equip_trouble ADD COLUMN IF NOT EXISTS end_date DATE`,
    `ALTER TABLE schedule_changes ADD COLUMN IF NOT EXISTS sampling_point VARCHAR(200) DEFAULT ''`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS logged_by VARCHAR(50)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS current_shift_team VARCHAR(5)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS current_supervisor VARCHAR(100)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS handover_shift_team VARCHAR(5)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS handover_supervisor VARCHAR(100)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS pending_samples_note TEXT`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS lims_issues TEXT`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS general_remarks TEXT`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS outgoing_name VARCHAR(50)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS outgoing_ts TIMESTAMPTZ`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS incoming_name VARCHAR(50)`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS incoming_ts TIMESTAMPTZ`,
    `ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) { console.warn('Migration skipped:', e.message); }
  }

  console.log('✅  Database tables ready');
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'handover.html')));

app.get('/api/equipment', (_req, res) => res.json(EQUIPMENT));

async function loadFull(reportId) {
  const { rows:[r] } = await pool.query('SELECT * FROM handover_reports WHERE id=$1',[reportId]);
  if (!r) return null;
  const { rows: trouble }    = await pool.query('SELECT * FROM equip_trouble    WHERE report_id=$1 ORDER BY id',[reportId]);
  const { rows: pending }    = await pool.query('SELECT * FROM pending_samples  WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  const { rows: schedules }  = await pool.query('SELECT * FROM schedule_changes WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  const { rows: reqsamples }   = await pool.query('SELECT * FROM requested_samples WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  const { rows: limsRows }      = await pool.query('SELECT * FROM lims_issues    WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  const { rows: remarksRows }   = await pool.query('SELECT * FROM general_remarks WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  const { rows: impexpRows }    = await pool.query('SELECT * FROM import_export   WHERE report_id=$1 ORDER BY sort_order,id',[reportId]);
  return { ...r, trouble, pending, schedules, reqsamples, limsRows, remarksRows, impexpRows };
}

app.get('/api/reports', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||60, 200);
    const { rows } = await pool.query(
      `SELECT id,shift_date,shift_type,logged_by,current_shift_team,current_supervisor,
              handover_shift_team,handover_supervisor,
              outgoing_name,outgoing_ts,incoming_name,incoming_ts,locked,updated_at
       FROM handover_reports ORDER BY shift_date DESC, shift_type DESC LIMIT $1`,[limit]);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/reports/by-shift', async (req, res) => {
  try {
    const { date, shift } = req.query;
    const { rows:[r] } = await pool.query(
      'SELECT * FROM handover_reports WHERE shift_date=$1 AND shift_type=$2',[date,shift]);
    if (!r) return res.json(null);
    res.json(await loadFull(r.id));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/reports/:id', async (req, res) => {
  try {
    const data = await loadFull(req.params.id);
    if (!data) return res.status(404).json({error:'Not found'});
    res.json(data);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/reports', async (req, res) => {
  const { shift_date,shift_type,logged_by,current_shift_team,current_supervisor,
          handover_shift_team,handover_supervisor,pending_samples_note,
          lims_issues,general_remarks } = req.body;
  try {
    const { rows:[r] } = await pool.query(`
      INSERT INTO handover_reports
        (shift_date,shift_type,logged_by,current_shift_team,current_supervisor,
         handover_shift_team,handover_supervisor,pending_samples_note,lims_issues,general_remarks,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (shift_date,shift_type) DO UPDATE SET
        logged_by=$3,current_shift_team=$4,current_supervisor=$5,
        handover_shift_team=$6,handover_supervisor=$7,
        pending_samples_note=$8,lims_issues=$9,general_remarks=$10,updated_at=NOW()
      RETURNING *`,
      [shift_date,shift_type,logged_by||'',current_shift_team||'A',current_supervisor||'',
       handover_shift_team||'A',handover_supervisor||'',pending_samples_note||'',
       lims_issues||'',general_remarks||'']);
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/reports/:id/signoff', async (req, res) => {
  const { role, name } = req.body;
  try {
    let q, params;
    if (role === 'outgoing') {
      q = `UPDATE handover_reports SET outgoing_name=$1,outgoing_ts=NOW(),updated_at=NOW() WHERE id=$2 AND (locked IS FALSE OR locked IS NULL) RETURNING *`;
      params = [name, req.params.id];
    } else {
      q = `UPDATE handover_reports SET incoming_name=$1,incoming_ts=NOW(),locked=TRUE,updated_at=NOW() WHERE id=$2 RETURNING *`;
      params = [name, req.params.id];
    }
    const { rows:[r] } = await pool.query(q, params);
    if (!r) return res.status(404).json({error:'Not found or already locked'});
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/reports/:id/trouble', async (req, res) => {
  const { equip_code,equip_name,owner,issue_type,issue_other,
          details,root_cause,action_taken,out_of_service,status,start_date,end_date } = req.body;
  try {
    const { rows:[r] } = await pool.query(`
      INSERT INTO equip_trouble
        (report_id,equip_code,equip_name,owner,issue_type,issue_other,
         details,root_cause,action_taken,out_of_service,status,start_date,end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.id,equip_code||'',equip_name||'',owner||'',
       issue_type||'Failed SQC',issue_other||'',details||'',
       root_cause||'',action_taken||'',out_of_service||'No',status||'Investigating',
       start_date||null,end_date||null]);
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/trouble/:id', async (req, res) => {
  const f = ['equip_code','equip_name','owner','issue_type','issue_other',
             'details','root_cause','action_taken','out_of_service','status','start_date','end_date'];
  try {
    const { rows:[r] } = await pool.query(
      `UPDATE equip_trouble SET ${f.map((x,i)=>`${x}=$${i+1}`).join(',')} WHERE id=$${f.length+1} RETURNING *`,
      [...f.map(x => { const v = req.body[x]; return (v === '' || v === undefined || v === null) ? null : v; }), req.params.id]);
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/trouble/:id', async (req, res) => {
  try { await pool.query('DELETE FROM equip_trouble WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/reports/:id/pending', async (req, res) => {
  const rows = req.body;
  try {
    const existingIds = rows.filter(r=>r.id).map(r=>r.id);
    // Delete rows that were removed by the user
    if (existingIds.length > 0) {
      await pool.query(`DELETE FROM pending_samples WHERE report_id=$1 AND id != ALL($2::int[])`, [req.params.id, existingIds]);
    } else {
      await pool.query('DELETE FROM pending_samples WHERE report_id=$1', [req.params.id]);
    }
    for (let i=0;i<rows.length;i++) {
      if (rows[i].id) {
        await pool.query(`UPDATE pending_samples SET sample_point=$1,reason=$2,action_needed=$3,status=$4,sort_order=$5 WHERE id=$6`,
          [rows[i].sample_point||'',rows[i].reason||'',rows[i].action_needed||'',rows[i].status||'In-progress',i,rows[i].id]);
      } else {
        await pool.query(`INSERT INTO pending_samples (report_id,sample_point,reason,action_needed,status,sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id,rows[i].sample_point||'',rows[i].reason||'',rows[i].action_needed||'',rows[i].status||'In-progress',i]);
      }
    }
    const { rows:saved } = await pool.query('SELECT * FROM pending_samples WHERE report_id=$1 ORDER BY sort_order',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/reports/:id/schedules', async (req, res) => {
  const rows = req.body;
  try {
    await pool.query('DELETE FROM schedule_changes WHERE report_id=$1',[req.params.id]);
    for (let i=0;i<rows.length;i++)
      await pool.query(`INSERT INTO schedule_changes (report_id,plant,sampling_point,change_desc,effective_date,requested_by,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id,rows[i].plant||'',rows[i].sampling_point||'',rows[i].change_desc||'',rows[i].effective_date||null,rows[i].requested_by||'',i]);
    const { rows:saved } = await pool.query('SELECT * FROM schedule_changes WHERE report_id=$1 ORDER BY sort_order',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/reports/:id/reqsamples', async (req, res) => {
  const rows = req.body;
  try {
    await pool.query('DELETE FROM requested_samples WHERE report_id=$1',[req.params.id]);
    for (let i=0;i<rows.length;i++)
      await pool.query(`INSERT INTO requested_samples (report_id,plant,product_stream,test_items,requested_by,target_date,priority,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id,rows[i].plant||'',rows[i].product_stream||'',rows[i].test_items||'',
         rows[i].requested_by||'',rows[i].target_date||null,rows[i].priority||'Normal',i]);
    const { rows:saved } = await pool.query('SELECT * FROM requested_samples WHERE report_id=$1 ORDER BY sort_order',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});


app.patch('/api/reports/:id/unlock', async (req, res) => {
  const { password } = req.body;
  const UNLOCK_PASSWORD = process.env.UNLOCK_PASSWORD || 'lsp123';
  if (password !== UNLOCK_PASSWORD) {
    return res.status(403).json({ error: 'Incorrect password' });
  }
  try {
    const { rows:[r] } = await pool.query(
      `UPDATE handover_reports
       SET locked=FALSE, incoming_name=NULL, incoming_ts=NULL,
           outgoing_name=NULL, outgoing_ts=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ── Attachments (Equipment Trouble / Pending Samples file uploads) ─────────

app.post('/api/attachments', upload.array('files', 10), async (req, res) => {
  try {
    const { report_id, section, row_id, uploaded_by } = req.body;
    if (!report_id || !section || !row_id) {
      return res.status(400).json({ error: 'Missing report_id, section, or row_id' });
    }
    if (!['trouble', 'pending', 'lims', 'remarks', 'impexp'].includes(section)) {
      return res.status(400).json({ error: 'Invalid section' });
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const inserted = [];
    for (const file of req.files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const storagePath = `${section}/${row_id}/${Date.now()}-${safeName}`;

      const { error: upErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(storagePath);

      const { rows } = await pool.query(
        `INSERT INTO attachments (report_id, section, row_id, file_name, file_url, storage_path, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [report_id, section, row_id, file.originalname, pub.publicUrl, storagePath, uploaded_by || '']
      );
      inserted.push(rows[0]);
    }
    res.json(inserted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attachments/:reportId/:section', async (req, res) => {
  try {
    const { reportId, section } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM attachments WHERE report_id=$1 AND section=$2 ORDER BY uploaded_at ASC`,
      [reportId, section]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM attachments WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const att = rows[0];
    await supabase.storage.from(ATTACHMENT_BUCKET).remove([att.storage_path]);
    await pool.query(`DELETE FROM attachments WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LIMS Issues rows ─────────────────────────────────────────────────────────
app.put('/api/reports/:id/lims', async (req, res) => {
  const rows = req.body;
  try {
    const existingIds = rows.filter(r=>r.id).map(r=>r.id);
    if (existingIds.length > 0) {
      await pool.query(`DELETE FROM lims_issues WHERE report_id=$1 AND id != ALL($2::int[])`, [req.params.id, existingIds]);
    } else {
      await pool.query('DELETE FROM lims_issues WHERE report_id=$1', [req.params.id]);
    }
    for (let i=0;i<rows.length;i++) {
      if (rows[i].id) {
        await pool.query(`UPDATE lims_issues SET description=$1,sort_order=$2 WHERE id=$3`,
          [rows[i].description||'', i, rows[i].id]);
      } else {
        await pool.query('INSERT INTO lims_issues (report_id,description,sort_order) VALUES ($1,$2,$3)',
          [req.params.id, rows[i].description||'', i]);
      }
    }
    const {rows:saved} = await pool.query('SELECT * FROM lims_issues WHERE report_id=$1 ORDER BY sort_order',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── General Remarks rows ──────────────────────────────────────────────────────
app.put('/api/reports/:id/remarks', async (req, res) => {
  const rows = req.body;
  try {
    const existingIds = rows.filter(r=>r.id).map(r=>r.id);
    if (existingIds.length > 0) {
      await pool.query(`DELETE FROM general_remarks WHERE report_id=$1 AND id != ALL($2::int[])`, [req.params.id, existingIds]);
    } else {
      await pool.query('DELETE FROM general_remarks WHERE report_id=$1', [req.params.id]);
    }
    for (let i=0;i<rows.length;i++) {
      if (rows[i].id) {
        await pool.query(`UPDATE general_remarks SET description=$1,sort_order=$2 WHERE id=$3`,
          [rows[i].description||'', i, rows[i].id]);
      } else {
        await pool.query('INSERT INTO general_remarks (report_id,description,sort_order) VALUES ($1,$2,$3)',
          [req.params.id, rows[i].description||'', i]);
      }
    }
    const {rows:saved} = await pool.query('SELECT * FROM general_remarks WHERE report_id=$1 ORDER BY sort_order',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Import / Export rows ─────────────────────────────────────────────────────
app.put('/api/reports/:id/impexp', async (req, res) => {
  const rows = req.body;
  try {
    const existingIds = rows.filter(r=>r.id).map(r=>r.id);
    if (existingIds.length > 0) {
      await pool.query(`DELETE FROM import_export WHERE report_id=$1 AND id != ALL($2::int[])`, [req.params.id, existingIds]);
    } else {
      await pool.query('DELETE FROM import_export WHERE report_id=$1', [req.params.id]);
    }
    for (let i=0;i<rows.length;i++) {
      const r = rows[i];
      if (r.id) {
        await pool.query(
          `UPDATE import_export SET direction=$1,material=$2,etb=$3,num_tanks=$4,num_samples=$5,status=$6,quality=$7,remark=$8,sort_order=$9 WHERE id=$10`,
          [r.direction||'Import',r.material||'',r.etb||null,r.num_tanks||'',r.num_samples||'',r.status||'Initial',r.quality||'',r.remark||'',i,r.id]);
      } else {
        await pool.query(
          `INSERT INTO import_export (report_id,direction,material,etb,num_tanks,num_samples,status,quality,remark,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.params.id,r.direction||'Import',r.material||'',r.etb||null,r.num_tanks||'',r.num_samples||'',r.status||'Initial',r.quality||'',r.remark||'',i]);
      }
    }
    const {rows:saved} = await pool.query('SELECT * FROM import_export WHERE report_id=$1 ORDER BY sort_order,id',[req.params.id]);
    res.json(saved);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Copy attachments to new report rows ──────────────────────────────────────
// body: { from_report_id, to_report_id, row_map: [{old_row_id, new_row_id, section}] }
app.post('/api/attachments/copy', async (req, res) => {
  const { from_report_id, to_report_id, row_map } = req.body;
  try {
    const inserted = [];
    for (const { old_row_id, new_row_id, section } of row_map) {
      const { rows: atts } = await pool.query(
        `SELECT * FROM attachments WHERE report_id=$1 AND section=$2 AND row_id=$3`,
        [from_report_id, section, old_row_id]
      );
      for (const att of atts) {
        const { rows: [newAtt] } = await pool.query(
          `INSERT INTO attachments (report_id, section, row_id, file_name, file_url, storage_path, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [to_report_id, section, new_row_id, att.file_name, att.file_url, att.storage_path, att.uploaded_by]
        );
        inserted.push(newAtt);
      }
    }
    res.json(inserted);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/health', async (_,res) => {
  try { await pool.query('SELECT 1'); res.json({status:'ok'}); }
  catch(e){ res.status(500).json({status:'error',error:e.message}); }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀  Handover server running on port ${PORT}`));
}).catch(e => { console.error('❌  DB init failed:', e.message); process.exit(1); });
