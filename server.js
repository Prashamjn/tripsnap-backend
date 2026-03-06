const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Multer config - memory storage (files go straight to Supabase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/i;
    if (allowed.test(path.extname(file.originalname)) || allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── TRIPS ────────────────────────────────────────────────────────────────────

// Create a new trip
app.post('/api/trips', async (req, res) => {
  try {
    const { name, description, createdBy } = req.body;
    if (!name) return res.status(400).json({ error: 'Trip name required' });

    const inviteCode = uuidv4().split('-')[0].toUpperCase(); // Short code like "A3F7B2"

    const { data, error } = await supabase
      .from('trips')
      .insert([{ name, description, created_by: createdBy || 'Anonymous', invite_code: inviteCode }])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all trips (public listing - just shows name and photo count)
app.get('/api/trips', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trips')
      .select('id, name, description, created_by, invite_code, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get photo counts per trip
    const tripsWithCounts = await Promise.all(data.map(async (trip) => {
      const { count } = await supabase
        .from('photos')
        .select('*', { count: 'exact', head: true })
        .eq('trip_id', trip.id);
      return { ...trip, photo_count: count || 0 };
    }));

    res.json(tripsWithCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single trip by invite code or ID
app.get('/api/trips/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isUUID = /^[0-9a-f-]{36}$/i.test(identifier);

    const query = supabase.from('trips').select('*');
    const { data, error } = isUUID
      ? await query.eq('id', identifier).single()
      : await query.eq('invite_code', identifier).single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Trip not found' });

    // Get photo count
    const { count } = await supabase
      .from('photos')
      .select('*', { count: 'exact', head: true })
      .eq('trip_id', data.id);

    res.json({ ...data, photo_count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PHOTOS ───────────────────────────────────────────────────────────────────

// Upload photos to a trip
app.post('/api/trips/:tripId/photos', upload.array('photos', 50), async (req, res) => {
  try {
    const { tripId } = req.params;
    const { uploadedBy } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Verify trip exists
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id')
      .eq('id', tripId)
      .single();

    if (tripError || !trip) return res.status(404).json({ error: 'Trip not found' });

    const uploadedPhotos = [];

    for (const file of req.files) {
      const fileExt = path.extname(file.originalname).toLowerCase() || '.jpg';
      const fileName = `${tripId}/${uuidv4()}${fileExt}`;
      const thumbName = `${tripId}/thumbs/${uuidv4()}${fileExt}`;

      // Generate thumbnail using sharp
      let thumbBuffer;
      try {
        thumbBuffer = await sharp(file.buffer)
          .resize(400, 400, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 75 })
          .toBuffer();
      } catch {
        thumbBuffer = file.buffer; // fallback to original if sharp fails
      }

      // Upload original to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('trip-photos')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) throw uploadError;

      // Upload thumbnail
      await supabase.storage
        .from('trip-photos')
        .upload(thumbName, thumbBuffer, {
          contentType: 'image/jpeg',
          upsert: false
        });

      // Get public URLs
      const { data: { publicUrl } } = supabase.storage
        .from('trip-photos')
        .getPublicUrl(fileName);

      const { data: { publicUrl: thumbUrl } } = supabase.storage
        .from('trip-photos')
        .getPublicUrl(thumbName);

      // Save to DB
      const { data: photo, error: dbError } = await supabase
        .from('photos')
        .insert([{
          trip_id: tripId,
          file_name: file.originalname,
          file_path: fileName,
          thumb_path: thumbName,
          url: publicUrl,
          thumb_url: thumbUrl,
          uploaded_by: uploadedBy || 'Anonymous',
          file_size: file.size,
          mime_type: file.mimetype
        }])
        .select()
        .single();

      if (dbError) throw dbError;
      uploadedPhotos.push(photo);
    }

    res.json({ uploaded: uploadedPhotos.length, photos: uploadedPhotos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get photos for a trip
app.get('/api/trips/:tripId/photos', async (req, res) => {
  try {
    const { tripId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('photos')
      .select('*', { count: 'exact' })
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ photos: data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download all photos as ZIP
app.get('/api/trips/:tripId/download', async (req, res) => {
  try {
    const { tripId } = req.params;

    const { data: trip } = await supabase.from('trips').select('name').eq('id', tripId).single();
    const { data: photos } = await supabase.from('photos').select('*').eq('trip_id', tripId);

    if (!photos || photos.length === 0) {
      return res.status(404).json({ error: 'No photos found' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${trip?.name || 'trip'}-photos.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    const fetch = (await import('node-fetch')).default;

    for (const photo of photos) {
      try {
        const response = await fetch(photo.url);
        if (response.ok) {
          const buffer = await response.buffer();
          archive.append(buffer, { name: photo.file_name || `photo-${photo.id}.jpg` });
        }
      } catch (e) {
        console.error('Failed to fetch photo:', photo.id, e.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a photo
app.delete('/api/photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;

    const { data: photo } = await supabase.from('photos').select('*').eq('id', photoId).single();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    // Delete from storage
    await supabase.storage.from('trip-photos').remove([photo.file_path, photo.thumb_path]);

    // Delete from DB
    await supabase.from('photos').delete().eq('id', photoId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`TripSnap API running on port ${PORT}`));
