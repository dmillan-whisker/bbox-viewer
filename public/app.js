const imageInput = document.getElementById('imageInput');
const bboxInput = document.getElementById('bboxInput');
const bboxTextarea = document.getElementById('bboxTextarea');
const loadTextareaBtn = document.getElementById('loadTextareaBtn');
const bboxError = document.getElementById('bboxError');
const imageGrid = document.getElementById('imageGrid');
const bboxList = document.getElementById('bboxList');
const imageCounter = document.getElementById('imageCounter');
const bboxCounter = document.getElementById('bboxCounter');
const clearImagesBtn = document.getElementById('clearImagesBtn');
const clearBoxesBtn = document.getElementById('clearBoxesBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');

const palette = [
  '#f97316',
  '#14b8a6',
  '#6366f1',
  '#ef4444',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#0ea5e9',
  '#facc15',
  '#a855f7'
];

const state = {
  images: [],
  imageElements: new Map(),
  imagesByName: new Map(),
  boxes: [],
  objectUrls: [],
  metadataByName: new Map(),
  metadataByIndex: new Map()
};

imageInput.addEventListener('change', handleImageUpload);
bboxInput.addEventListener('change', handleBoundingFileUpload);
loadTextareaBtn.addEventListener('click', () => {
  const raw = bboxTextarea.value.trim();
  if (!raw) {
    setError('Nothing to parse. Paste JSON before loading.');
    return;
  }
  parseBoundingBoxes(raw, 'pasted JSON');
});

if (clearImagesBtn) {
  clearImagesBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearImages();
  });
}

if (clearBoxesBtn) {
  clearBoxesBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearBoxes();
  });
}

if (clearSessionBtn) {
  clearSessionBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearSession();
  });
}

function handleImageUpload(event) {
  clearError();
  const files = Array.from(event.target.files || []);
  revokeObjectUrls();
  state.images = files.map((file, index) => {
    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);
    const name = file.name || `image-${index + 1}`;
    return {
      index,
      url,
      name,
      size: file.size
    };
  });
  rebuildImageNameMap();
  renderImages();
  renderAllBoundingBoxes();
}

async function handleBoundingFileUpload(event) {
  clearError();
  const files = Array.from(event.target.files || []);
  for (const file of files) {
    try {
      const text = await file.text();
      parseBoundingBoxes(text, file.name);
    } catch (error) {
      setError(`Could not read ${file.name}: ${error.message}`);
    }
  }
  event.target.value = '';
}

function parseBoundingBoxes(rawText, sourceLabel) {
  clearError();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (error) {
    setError(`Invalid JSON (${sourceLabel}): ${error.message}`);
    return;
  }

  const entries = Array.isArray(payload) ? payload : [payload];
  const parsedBoxes = [];
  const warnings = [];

  entries.forEach((entry, idx) => {
    try {
      const box = normaliseEntry(entry, sourceLabel, idx);
      box.metadata = extractMetadata(entry, box.imageName);
      parsedBoxes.push(box);
    } catch (error) {
      warnings.push(`Skipped entry ${idx + 1}: ${error.message}`);
    }
  });

  if (!parsedBoxes.length) {
    setError(`No valid bounding boxes found in ${sourceLabel}.`);
    return;
  }

  const startIndex = state.boxes.length;
  parsedBoxes.forEach((box, offset) => {
    const color = palette[(startIndex + offset) % palette.length];
    box.color = color;
    box.fill = hexToRgba(color, 0.18);
    state.boxes.push(box);
    recordMetadataFromBox(box);
  });

  if (warnings.length) {
    setError(warnings.join(' '));
  }

  renderAllBoundingBoxes();
}

function normaliseEntry(entry, sourceLabel, entryIndex) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error('Entry is not an object.');
  }

  const container = typeof entry.box === 'object' && entry.box !== null ? entry.box : entry;

  const coordinates = extractCoordinates(container);
  if (!coordinates) {
    throw new Error('Missing coordinates (x1,y1,x2,y2 or x,y,width,height).');
  }

  const { x1, y1, x2, y2, warnings } = coordinates;

  const imageName = firstDefined(
    entry.image,
    entry.imageName,
    entry.filename,
    entry.file
  );

  const imageIndexRaw = firstDefined(entry.imageIndex, entry.index);
  const imageIndex = Number.isInteger(imageIndexRaw) ? imageIndexRaw : null;

  const label = firstDefined(entry.label, entry.class, entry.category, entry.id);

  return {
    source: sourceLabel,
    entryIndex,
    label: label || '',
    imageName: imageName ? String(imageName) : null,
    imageIndex,
    box: { x1, y1, x2, y2 },
    baseWarnings: warnings.length ? warnings : []
  };
}

function extractCoordinates(source) {
  const warnings = [];
  const coords = {};

  if (isFiniteNumber(source.x1) && isFiniteNumber(source.y1) && isFiniteNumber(source.x2) && isFiniteNumber(source.y2)) {
    coords.x1 = Number(source.x1);
    coords.y1 = Number(source.y1);
    coords.x2 = Number(source.x2);
    coords.y2 = Number(source.y2);
  } else if (isFiniteNumber(source.x) && isFiniteNumber(source.y) && isFiniteNumber(source.width) && isFiniteNumber(source.height)) {
    coords.x1 = Number(source.x);
    coords.y1 = Number(source.y);
    coords.x2 = Number(source.x) + Number(source.width);
    coords.y2 = Number(source.y) + Number(source.height);
    warnings.push('Interpreted x/y/width/height as x1/y1/x2/y2.');
  } else {
    return null;
  }

  const minX = Math.min(coords.x1, coords.x2);
  const maxX = Math.max(coords.x1, coords.x2);
  const minY = Math.min(coords.y1, coords.y2);
  const maxY = Math.max(coords.y1, coords.y2);

  if (maxX > 1 || maxY > 1 || minX < 0 || minY < 0) {
    warnings.push('Values outside [0,1] were clamped.');
  }

  return {
    x1: clamp01(minX),
    y1: clamp01(minY),
    x2: clamp01(maxX),
    y2: clamp01(maxY),
    warnings
  };
}

function renderImages() {
  imageGrid.replaceChildren();
  state.imageElements = new Map();

  state.images.forEach((image) => {
    const card = document.createElement('div');
    card.className = 'image-card';

    const info = document.createElement('div');
    info.className = 'image-info';
    const name = document.createElement('strong');
    name.textContent = image.name;
    const size = document.createElement('span');
    size.textContent = formatBytes(image.size);
    info.append(name, size);

    const stage = document.createElement('div');
    stage.className = 'image-stage';
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.name;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    stage.append(img, overlay);
    card.append(info, stage);

    const metadata = resolveMetadataForImage(image);
    const metadataModal = createMetadataModal(metadata, image);
    card.append(metadataModal);
    card.classList.toggle('has-metadata', Boolean(metadata));

    imageGrid.append(card);

    state.imageElements.set(image.index, { overlay, image, card, metadataModal });
    img.addEventListener('load', () => {
      renderAllBoundingBoxes();
    });
  });

  imageCounter.textContent = `${state.images.length} file${state.images.length === 1 ? '' : 's'}`;
}

function renderAllBoundingBoxes() {
  state.imageElements.forEach(({ overlay }) => {
    overlay.replaceChildren();
  });

  state.boxes.forEach((box, idx) => {
    box.dynamicWarnings = [];
    const target = resolveImageForBox(box);
    box.matched = Boolean(target);
    box.resolvedImageName = target ? target.image.name : null;

    if (target) {
      if (target.note) {
        box.dynamicWarnings.push(target.note);
      }

      const rect = document.createElement('div');
      rect.className = 'bbox-rect';
      rect.style.setProperty('--bbox-color', box.color);
      rect.style.setProperty('--bbox-fill', box.fill);

      const width = Math.max(box.box.x2 - box.box.x1, 0);
      const height = Math.max(box.box.y2 - box.box.y1, 0);

      rect.style.left = `${box.box.x1 * 100}%`;
      rect.style.top = `${box.box.y1 * 100}%`;
      rect.style.width = `${width * 100}%`;
      rect.style.height = `${height * 100}%`;

      const label = document.createElement('span');
      const labelText = box.label ? box.label : `Box ${idx + 1}`;
      label.textContent = labelText;
      rect.append(label);
      target.overlay.append(rect);

      if (typeof target.index === 'number' && box.metadata) {
        recordMetadataForResolvedImage(target.index, box);
      }
    }
  });

  bboxCounter.textContent = `${state.boxes.length} box${state.boxes.length === 1 ? '' : 'es'}`;
  renderBoundingSummary();
}

function renderBoundingSummary() {
  bboxList.replaceChildren();
  if (!state.boxes.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = 'No bounding boxes loaded yet.';
    bboxList.append(empty);
    return;
  }

  state.boxes.forEach((box, idx) => {
    const item = document.createElement('div');
    item.className = 'bbox-item';
    if (!box.matched) {
      item.classList.add('unmatched');
    }
    item.style.setProperty('--bbox-color', box.color);

    const header = document.createElement('strong');
    header.textContent = `#${idx + 1}`;

    const source = document.createElement('div');
    source.innerHTML = `<strong>Source:</strong> ${box.source}`;

    const imageName = document.createElement('div');
    const resolved = box.resolvedImageName || box.imageName || 'not matched';
    imageName.innerHTML = `<strong>Image:</strong> ${resolved}`;

    const label = document.createElement('div');
    label.innerHTML = `<strong>Label:</strong> ${box.label || '—'}`;

    const coords = document.createElement('div');
    coords.innerHTML = `<strong>Coords:</strong> (${formatNumber(box.box.x1)}, ${formatNumber(box.box.y1)}) → (${formatNumber(box.box.x2)}, ${formatNumber(box.box.y2)})`;

    item.append(header, source, imageName, label, coords);

    const notes = [
      ...(box.baseWarnings || []),
      ...(box.dynamicWarnings || [])
    ];
    if (!box.matched) {
      notes.push('No matching image found for this box.');
    }

    if (notes.length) {
      const warning = document.createElement('div');
      warning.className = 'bbox-warning';
      warning.textContent = notes.join(' ');
      item.append(warning);
    }

    bboxList.append(item);
  });
}

function resolveImageForBox(box) {
  const byName = normaliseName(box.imageName);
  if (byName && state.imagesByName.has(byName)) {
    const candidates = state.imagesByName.get(byName);
    if (box.imageIndex !== null && box.imageIndex >= 0 && box.imageIndex < state.images.length) {
      const exact = candidates.find((candidate) => candidate.index === box.imageIndex);
      if (exact) {
        const element = state.imageElements.get(exact.index);
        return element ? { overlay: element.overlay, image: element.image, note: null, index: exact.index } : null;
      }
    }
    const fallback = candidates[0];
    const fallbackElement = state.imageElements.get(fallback.index);
    return fallbackElement ? { overlay: fallbackElement.overlay, image: fallbackElement.image, note: null, index: fallback.index } : null;
  }

  if (box.imageIndex !== null && box.imageIndex >= 0 && box.imageIndex < state.images.length) {
    const element = state.imageElements.get(box.imageIndex);
    return element ? { overlay: element.overlay, image: element.image, note: null, index: box.imageIndex } : null;
  }

  if (!byName && state.images.length === 1) {
    const element = state.imageElements.get(0);
    if (element) {
      return { overlay: element.overlay, image: element.image, note: 'Applied box to the only loaded image.', index: 0 };
    }
  }

  return null;
}

function resolveMetadataForImage(image) {
  if (!image) {
    return null;
  }
  const nameKey = normaliseName(image.name);
  const byName = nameKey ? state.metadataByName.get(nameKey) : null;
  const byIndex = state.metadataByIndex.get(image.index);
  return combineMetadata(byIndex, byName);
}

function createMetadataModal(metadata, image) {
  const container = document.createElement('div');
  container.className = 'image-metadata-modal';
  renderMetadataContent(container, metadata, image);
  return container;
}

function renderMetadataContent(container, metadata, image) {
  container.replaceChildren();

  const title = document.createElement('strong');
  title.className = 'metadata-title';
  title.textContent = 'Metadata';
  container.append(title);

  if (!metadata) {
    const empty = document.createElement('p');
    empty.className = 'metadata-empty';
    empty.textContent = 'No metadata available for this image yet.';
    container.append(empty);
    return;
  }

  const list = document.createElement('dl');
  list.className = 'metadata-list';
  appendMetadataRow(list, 'Image', metadata.image || image.name || '—');
  appendMetadataRow(list, 's3Key', metadata.s3Key);
  appendMetadataRow(list, 'Timestamp', metadata.timestamp);
  appendMetadataRow(list, 'Detected at', metadata.detected_at || metadata.detected_at_raw);
  container.append(list);
}

function appendMetadataRow(list, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value !== undefined && value !== null && value !== '' ? String(value) : '—';
  list.append(dt, dd);
}

function recordMetadataFromBox(box) {
  if (!box || !box.metadata) {
    return;
  }

  const metadata = box.metadata;
  const nameKey = normaliseName(box.imageName || metadata.image);
  if (nameKey) {
    const currentByName = state.metadataByName.get(nameKey);
    state.metadataByName.set(nameKey, combineMetadata(metadata, currentByName));
  }

  if (Number.isInteger(box.imageIndex)) {
    const currentByIndex = state.metadataByIndex.get(box.imageIndex);
    state.metadataByIndex.set(box.imageIndex, combineMetadata(metadata, currentByIndex));
  }

  const impactedIndexes = new Set();
  if (Number.isInteger(box.imageIndex)) {
    impactedIndexes.add(box.imageIndex);
  }
  if (nameKey && state.imagesByName.has(nameKey)) {
    state.imagesByName.get(nameKey).forEach((image) => impactedIndexes.add(image.index));
  }

  impactedIndexes.forEach((imageIndex) => {
    refreshMetadataForImage(imageIndex);
  });
}

function recordMetadataForResolvedImage(imageIndex, box) {
  if (!box || !box.metadata || typeof imageIndex !== 'number') {
    return;
  }

  const enriched = {
    ...box.metadata,
    image: box.metadata.image || box.resolvedImageName || (state.images[imageIndex] ? state.images[imageIndex].name : null)
  };

  const nameKey = normaliseName(box.resolvedImageName || box.imageName || enriched.image);
  if (nameKey) {
    const currentByName = state.metadataByName.get(nameKey);
    state.metadataByName.set(nameKey, combineMetadata(enriched, currentByName));
  }

  const current = state.metadataByIndex.get(imageIndex);
  state.metadataByIndex.set(imageIndex, combineMetadata(enriched, current));
  refreshMetadataForImage(imageIndex);
}

function refreshMetadataForImage(imageIndex) {
  const element = state.imageElements.get(imageIndex);
  if (!element || !element.card) {
    return;
  }

  const metadata = resolveMetadataForImage(element.image);
  if (!element.metadataModal) {
    element.metadataModal = createMetadataModal(metadata, element.image);
    element.card.append(element.metadataModal);
  } else {
    renderMetadataContent(element.metadataModal, metadata, element.image);
  }
  element.card.classList.toggle('has-metadata', Boolean(metadata));
}

function combineMetadata(...sources) {
  const template = {
    image: null,
    s3Key: null,
    timestamp: null,
    detected_at: null,
    detected_at_raw: null
  };

  let hasValue = false;

  sources.forEach((source) => {
    if (!source) {
      return;
    }

    if (template.image === null && source.image !== undefined && source.image !== null && source.image !== '') {
      template.image = String(source.image);
      hasValue = true;
    }
    if (template.s3Key === null && source.s3Key !== undefined && source.s3Key !== null && source.s3Key !== '') {
      template.s3Key = String(source.s3Key);
      hasValue = true;
    }
    if (template.timestamp === null && source.timestamp !== undefined && source.timestamp !== null && source.timestamp !== '') {
      template.timestamp = String(source.timestamp);
      hasValue = true;
    }
    if (template.detected_at === null && source.detected_at !== undefined && source.detected_at !== null && source.detected_at !== '') {
      template.detected_at = String(source.detected_at);
      hasValue = true;
    }
    if (template.detected_at_raw === null && source.detected_at_raw !== undefined && source.detected_at_raw !== null && source.detected_at_raw !== '') {
      template.detected_at_raw = String(source.detected_at_raw);
      hasValue = true;
    }
  });

  return hasValue ? template : null;
}

function extractMetadata(entry, fallbackImageName) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const imageField = firstDefined(
    entry.image,
    entry.imageName,
    entry.filename,
    entry.file,
    fallbackImageName
  );

  const s3Key = firstDefined(entry.s3Key, entry.s3_key, entry.key);
  const timestamp = firstDefined(entry.timestamp, entry.time, entry.captured_at);
  const detectedAtRaw = firstDefined(entry.detected_at, entry.detectedAt);
  const detectedAtFormatted = formatDetectedAt(detectedAtRaw);

  if (
    imageField === undefined &&
    s3Key === undefined &&
    timestamp === undefined &&
    detectedAtRaw === undefined
  ) {
    return null;
  }

  return {
    image: imageField !== undefined && imageField !== null ? String(imageField) : null,
    s3Key: s3Key !== undefined && s3Key !== null ? String(s3Key) : null,
    timestamp: timestamp !== undefined && timestamp !== null ? String(timestamp) : null,
    detected_at: detectedAtFormatted,
    detected_at_raw: detectedAtRaw !== undefined && detectedAtRaw !== null ? String(detectedAtRaw) : null
  };
}

function formatDetectedAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const milliseconds = numeric / 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function rebuildImageNameMap() {
  state.imagesByName = new Map();
  state.images.forEach((image) => {
    const key = normaliseName(image.name);
    if (!key) {
      return;
    }
    if (!state.imagesByName.has(key)) {
      state.imagesByName.set(key, []);
    }
    state.imagesByName.get(key).push(image);
  });
}

function revokeObjectUrls() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
}

function clearImages() {
  revokeObjectUrls();
  state.images = [];
  state.imageElements = new Map();
  state.imagesByName = new Map();
  imageInput.value = '';
  renderImages();
  renderAllBoundingBoxes();
  clearError();
}

function clearBoxes() {
  state.boxes = [];
  state.metadataByName.clear();
  state.metadataByIndex.clear();
  bboxTextarea.value = '';
  bboxInput.value = '';
  renderAllBoundingBoxes();
  state.imageElements.forEach((_, index) => {
    refreshMetadataForImage(index);
  });
  clearError();
}

function clearSession() {
  clearImages();
  clearBoxes();
}

function clearError() {
  bboxError.textContent = '';
}

function setError(message) {
  bboxError.textContent = message;
}

function normaliseName(name) {
  return name ? String(name).trim().toLowerCase() : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function isFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function formatNumber(value) {
  return Number(value).toFixed(3);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function hexToRgba(hexColor, alpha) {
  const hex = hexColor.replace('#', '');
  const chunk = hex.length === 3 ? hex.split('').map((char) => char + char) : hex.match(/.{2}/g);
  if (!chunk || chunk.length < 3) {
    return `rgba(249, 115, 22, ${alpha})`;
  }
  const [r, g, b] = chunk.slice(0, 3).map((part) => parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

window.addEventListener('beforeunload', () => {
  revokeObjectUrls();
});
