const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors'); // Tambahan CORS

const app = express();
const PORT = 3009;

// Mengizinkan akses dari semua origin (CORS)
app.use(cors());

// Daftar titik yang akan diambil
const TARGET_STATIONS = [
    "POS DUGA AIR MAHAKAM LONG PAHANGAI",
    "POS DUGA AIR MAHAKAM BATOQ KELO",
    "POS DUGA AIR MAHAKAM LONG BAGUN",
    "POS DUGA AIR MAHAKAM LONG IRAM",
    "POS DUGA AIR MAHAKAM PENYINGGAHAN ULU",
    "POS DUGA AIR PELA SANGKULIMAN",
    "POS DUGA AIR MAHAKAM TENGGARONG",
    "POS DUGA AIR KARANG MUMUS KP 3"
];

// Koneksi Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Gagal membuka database:', err.message);
    else console.log('Terhubung ke database SQLite.');
});

// Penyesuaian Skema Database: Menggunakan tma_07
db.run(`
    CREATE TABLE IF NOT EXISTS water_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station TEXT,
        tma_07 REAL,
        record_date DATETIME,
        UNIQUE(station, record_date)
    )
`);

// ---------------------------------------------------------
// 1. ENDPOINT UNTUK WEB UTAMA (Menampilkan Data)
// ---------------------------------------------------------
app.get('/api/water-levels', (req, res) => {
    const sql = `SELECT * FROM water_levels ORDER BY record_date DESC`;
    
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const grouped = {};
        
        rows.forEach(row => {
            if (!grouped[row.station]) {
                grouped[row.station] = {
                    station: row.station,
                    data: []
                };
            }
            
            grouped[row.station].data.push({
                record_date: row.record_date,
                tma_07: row.tma_07
            });
        });

        const responseData = Object.values(grouped);
        res.json({ data: responseData });
    });
});

// ---------------------------------------------------------
// 2. ENDPOINT LOAD DATA HISTORIS DARI history.json
// ---------------------------------------------------------
app.get('/api/load-history', (req, res) => {
    try {
        if (!fs.existsSync('./history.json')) {
            return res.status(404).json({ message: "File history.json tidak ditemukan" });
        }

        const rawData = fs.readFileSync('./history.json');
        const historyData = JSON.parse(rawData);

        // Menggunakan UPSERT agar data tidak bentrok dan bisa menimpa data kosong
        const stmt = db.prepare(`
            INSERT INTO water_levels (station, tma_07, record_date) 
            VALUES (?, ?, ?)
            ON CONFLICT(station, record_date) 
            DO UPDATE SET tma_07 = excluded.tma_07
        `);
        
        let count = 0;
        
        historyData.forEach(siteItem => {
            siteItem.data.forEach(record => {
                stmt.run(siteItem.station, record.tma_07, record.record_date);
                count++;
            });
        });
        
        stmt.finalize();
        res.json({ message: `Berhasil memuat ${count} data historis ke database.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 3. ENDPOINT SINKRONISASI MANUAL
// ---------------------------------------------------------
app.get('/api/sync', async (req, res) => {
    try {
        const response = await axios.get('https://api.hidrologi.id/duga-air');
        const apiData = response.data;

        const stmt = db.prepare(`
            INSERT INTO water_levels (station, tma_07, record_date) 
            VALUES (?, ?, ?)
            ON CONFLICT(station, record_date) 
            DO UPDATE SET tma_07 = excluded.tma_07
        `);
        
        let updatedCount = 0;

        for (const region in apiData) {
            const stationsArray = apiData[region];
            stationsArray.forEach(item => {
                if (TARGET_STATIONS.includes(item.nama)) {
                    stmt.run(item.nama, item.tma_07, item.tanggal);
                    updatedCount++;
                }
            });
        }
        stmt.finalize();
        
        res.json({ message: `Sinkronisasi sukses. ${updatedCount} titik target diperbarui dari BWS.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 4. CRON JOB: Ambil API BWS Setiap 1 Jam & Filter
// ---------------------------------------------------------
// Format cron '0 * * * *' artinya berjalan setiap pergantian jam (01.00, 02.00, dst)
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Memulai proses sinkronisasi BWS (Per 1 Jam)...');

    try {
        const response = await axios.get('https://api.hidrologi.id/duga-air');
        const apiData = response.data;

        // Menggunakan UPSERT untuk menimpa nilai null/lama dengan yang baru
        const stmt = db.prepare(`
            INSERT INTO water_levels (station, tma_07, record_date) 
            VALUES (?, ?, ?)
            ON CONFLICT(station, record_date) 
            DO UPDATE SET tma_07 = excluded.tma_07
        `);
        
        let insertedCount = 0;

        for (const region in apiData) {
            const stationsArray = apiData[region];
            
            stationsArray.forEach(item => {
                if (TARGET_STATIONS.includes(item.nama)) {
                    stmt.run(item.nama, item.tma_07, item.tanggal);
                    insertedCount++;
                }
            });
        }
        stmt.finalize();
        console.log(`[CRON] ${insertedCount} data target dari BWS berhasil disinkronkan.`);

        // Housekeeping: Hapus data > 10 hari
        db.run(`DELETE FROM water_levels WHERE record_date <= datetime('now', '-10 days')`, function(err) {
            if (err) console.error('[CRON] Gagal menghapus data lama:', err.message);
            else if (this.changes > 0) console.log(`[CRON] Housekeeping selesai. Menghapus ${this.changes} baris data lama.`);
        });

    } catch (error) {
        console.error('[CRON] Gagal mengambil API BWS:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Gateway API berjalan di http://localhost:${PORT}`);
});