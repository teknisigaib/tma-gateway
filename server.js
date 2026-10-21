const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = 3009;

// Daftar titik yang akan diambil
const TARGET_STATIONS = [
    "POS DUGA AIR MAHAKAM LONG PAHANGAI",
    "POS DUGA MAHAKAM AIR BATOQ KELO",
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

// Penyesuaian Skema Database: Hanya menggunakan tma_07
db.run(`
    CREATE TABLE IF NOT EXISTS water_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station TEXT,
        tma_07 REAL,
        record_date DATETIME,
        UNIQUE(station, record_date)
    )
`);

/// ---------------------------------------------------------
// 1. ENDPOINT UNTUK WEB UTAMA (Menampilkan Data)
// ---------------------------------------------------------
app.get('/api/water-levels', (req, res) => {
    // Mengambil semua data, diurutkan berdasarkan waktu terbaru
    const sql = `SELECT * FROM water_levels ORDER BY record_date DESC`;
    
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Objek sementara untuk mengelompokkan data berdasarkan station
        const grouped = {};
        
        rows.forEach(row => {
            // Jika station belum ada di objek 'grouped', buat kerangkanya
            if (!grouped[row.station]) {
                grouped[row.station] = {
                    station: row.station,
                    data: []
                };
            }
            
            // Masukkan data waktu dan tma_07 ke dalam nested array
            grouped[row.station].data.push({
                record_date: row.record_date,
                tma_07: row.tma_07
            });
        });

        // Mengubah objek 'grouped' kembali menjadi array
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

        const stmt = db.prepare(`INSERT OR IGNORE INTO water_levels (station, tma_07, record_date) VALUES (?, ?, ?)`);
        
        let count = 0;
        
        // Loop pertama: Masuk ke tiap pos/station
        historyData.forEach(siteItem => {
            // Loop kedua: Masuk ke array data di dalam pos tersebut
            siteItem.data.forEach(record => {
                stmt.run(siteItem.station, record.tma_07, record.record_date);
                count++;
            });
        });
        
        stmt.finalize();

        res.json({ message: `Berhasil memuat ${count} data historis dari ${historyData.length} stasiun ke database.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 3. CRON JOB: Ambil API BWS & Filter Target Stations
// ---------------------------------------------------------
cron.schedule('50 23 * * *', async () => {
    console.log('[CRON] Memulai proses sinkronisasi BWS...');

    try {
        const response = await axios.get('https://api.hidrologi.id/duga-air');
        const apiData = response.data;

        // Kueri insert disederhanakan hanya untuk tma_07
        const stmt = db.prepare(`INSERT OR IGNORE INTO water_levels (station, tma_07, record_date) VALUES (?, ?, ?)`);
        let insertedCount = 0;

        for (const region in apiData) {
            const stationsArray = apiData[region];
            
            stationsArray.forEach(item => {
                if (TARGET_STATIONS.includes(item.nama)) {
                    // Hanya mengambil tma_07 dari API BWS
                    stmt.run(item.nama, item.tma_07, item.tanggal);
                    insertedCount++;
                }
            });
        }
        stmt.finalize();
        console.log(`[CRON] ${insertedCount} data target dari BWS berhasil disimpan.`);

        // Housekeeping: Hapus data > 10 hari
        db.run(`DELETE FROM water_levels WHERE record_date <= datetime('now', '-10 days')`, function(err) {
            if (err) console.error('[CRON] Gagal menghapus data lama:', err.message);
            else console.log(`[CRON] Housekeeping selesai. Menghapus ${this.changes} baris data lama.`);
        });

    } catch (error) {
        console.error('[CRON] Gagal mengambil API BWS:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Gateway API berjalan di http://localhost:${PORT}`);
});