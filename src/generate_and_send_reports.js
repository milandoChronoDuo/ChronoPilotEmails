require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Supabase-Client und SendGrid konfigurieren
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Formatierungshilfen (gleich wie im Original)
function formatDate(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const options = dateStr.includes("T")
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return new Intl.DateTimeFormat('de-DE', options).format(date);
}

function formatTableName(tableName) {
  const match = tableName.match(/(.*)_\d{2}_\d{4}$/);
  if (match) {
    return match[1]
      .split(/[\s_]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  return tableName;
}

function addHeader(doc, tableName) {
  const displayName = formatTableName(tableName);
  const dateOptions = { month: 'long', year: 'numeric' };
  const headerText = `ChronoPilot Bericht - ${displayName} - ${new Date().toLocaleDateString('de-DE', dateOptions)}`;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#2c3e50').text(headerText, { align: 'center' });
  const lineY = doc.y + 5;
  doc.moveTo(doc.page.margins.left, lineY).lineTo(doc.page.width - doc.page.margins.right, lineY)
    .strokeColor('#bdc3c7').lineWidth(1).stroke();
  doc.moveDown(1);
}

function drawFooter(doc, currentPage) {
  const footerY = doc.page.height - doc.page.margins.bottom - 40;
  doc.moveTo(doc.page.margins.left, footerY).lineTo(doc.page.width - doc.page.margins.right, footerY)
    .strokeColor('#bdc3c7').lineWidth(1).stroke();
  doc.fontSize(10).fillColor('#7f8c8d')
    .text(`Seite ${currentPage}`, doc.page.margins.left, footerY + 5, {
      align: 'center',
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right
    });
}

function computeColumnWidths(doc, columns, data, tableWidth) {
  const padding = 20;
  let requiredWidths = [];
  doc.font('Helvetica-Bold').fontSize(12);
  columns.forEach(col => {
    let maxWidth = doc.widthOfString(col);
    data.forEach(row => {
      const text = row[col] ? row[col].toString() : '';
      doc.font('Helvetica').fontSize(10);
      maxWidth = Math.max(maxWidth, doc.widthOfString(text));
    });
    requiredWidths.push(maxWidth + padding);
  });
  const totalRequired = requiredWidths.reduce((sum, w) => sum + w, 0);
  if (totalRequired < tableWidth) {
    const extra = (tableWidth - totalRequired) / columns.length;
    return requiredWidths.map(w => w + extra);
  } else {
    const scale = tableWidth / totalRequired;
    return requiredWidths.map(w => w * scale);
  }
}

function calculateRowMetrics(doc, columns, row) {
  let maxHeight = 20;
  const cellHeights = columns.map(col => {
    const text = row[col] ? row[col].toString() : '';
    const height = doc.fontSize(10).heightOfString(text, { width: 100 });
    maxHeight = Math.max(maxHeight, height);
    return height;
  });
  return { rowHeight: maxHeight + 15, cellHeights };
}

function drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths) {
  let y = doc.y;
  doc.rect(margin, y, tableWidth, headerHeight).fill('#3498db');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(12);
  let cumX = margin;
  columns.forEach((col, i) => {
    doc.text(col, cumX + 5, y + 10, { width: columnWidths[i] - 10 });
    cumX += columnWidths[i];
  });
  doc.strokeColor('#bdc3c7').lineWidth(2).rect(margin, y, tableWidth, headerHeight).stroke();
  cumX = margin;
  doc.lineWidth(1);
  for (let i = 1; i < columns.length; i++) {
    cumX += columnWidths[i - 1];
    doc.moveTo(cumX, y).lineTo(cumX, y + headerHeight).stroke();
  }
  doc.y += headerHeight;
}

function drawTable(doc, tableName, data) {
  if (data.length === 0) {
    doc.fontSize(12).fillColor('red').text('Keine Daten verfügbar', { align: 'center' });
    return;
  }

  const margin = 50;
  const tableWidth = doc.page.width - margin * 2;
  const columns = Object.keys(data[0]);
  const columnWidths = computeColumnWidths(doc, columns, data, tableWidth);

  const headerHeights = columns.map((col, i) => doc.heightOfString(col, { width: columnWidths[i] - 10 }));
  const headerHeight = Math.max(...headerHeights) + 20;
  drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths);

  let y = doc.y;
  let currentPage = 1;

  data.forEach((row, rowIndex) => {
    const { rowHeight } = calculateRowMetrics(doc, columns, row);
    const footerSpace = 50;
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - footerSpace) {
      drawFooter(doc, currentPage);
      doc.addPage({ margin: 50, size: 'A4' });
      currentPage++;
      addHeader(doc, tableName);
      drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths);
      y = doc.y;
    }

    doc.rect(margin, y, tableWidth, rowHeight).fill(rowIndex % 2 === 0 ? '#ecf0f1' : '#ffffff');
    let cumX = margin;
    doc.font('Helvetica').fontSize(10).fillColor('#2c3e50');
    columns.forEach((col, i) => {
      let value = row[col];
      if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) value = formatDate(value);
      doc.text(value ? value.toString() : '-', cumX + 5, y + 5, {
        width: columnWidths[i] - 10,
        align: 'left',
        ellipsis: true
      });
      cumX += columnWidths[i];
    });

    doc.strokeColor('#bdc3c7').lineWidth(1).rect(margin, y, tableWidth, rowHeight).stroke();
    cumX = margin;
    for (let i = 1; i < columns.length; i++) {
      cumX += columnWidths[i - 1];
      doc.moveTo(cumX, y).lineTo(cumX, y + rowHeight).stroke();
    }

    y += rowHeight;
    doc.y = y;
  });

  drawFooter(doc, currentPage);
}

async function generatePdfForTable(tableName, data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, font: 'Helvetica' });
    const filePath = path.join(__dirname, `${tableName}.pdf`);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    addHeader(doc, tableName);
    drawTable(doc, tableName, data);
    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

async function sendEmailWithAttachments(subject, text, attachments) {
  const msg = {
    to: process.env.EMAIL_TO,
    from: process.env.EMAIL_FROM,
    subject,
    text,
    attachments: attachments.map(filePath => ({
      content: fs.readFileSync(filePath).toString('base64'),
      filename: path.basename(filePath),
      type: 'application/pdf',
      disposition: 'attachment'
    }))
  };
  await sgMail.send(msg);
  console.log(`Email mit ${attachments.length} Anhängen versendet`);
}

async function uploadPdfToBucket(filePath) {
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);
  const { error } = await supabase.storage.from(process.env.BUCKET_NAME).upload(fileName, fileData, {
    contentType: 'application/pdf',
    upsert: true
  });
  if (error) throw error;
  console.log(`Datei hochgeladen: ${fileName}`);
}

async function runReportWorkflow() {
  try {
    console.log('Starte PDF-Workflow...');
    const pdfPaths = [];
    const staticTables = ['raw_data', 'gesamtzeiten', 'urlaubsantraege', 'daily_summary', 'baustellenzeit'];

    for (const table of staticTables) {
      const { data, error } = await supabase.from(table).select('*');
      if (error) continue;
      const pdfPath = await generatePdfForTable(table, data || []);
      pdfPaths.push(pdfPath);
    }

    const { data: dynamicTables } = await supabase.rpc('get_dynamic_tables');
    const currentMonthYear = `${String(new Date().getMonth() + 1).padStart(2, '0')}_${new Date().getFullYear()}`;
    const relevantTables = dynamicTables.filter(t => t.table_name.endsWith(currentMonthYear));

    for (const table of relevantTables) {
      const { data, error } = await supabase.from(table.table_name).select('*');
      if (error) continue;
      const pdfPath = await generatePdfForTable(table.table_name, data || []);
      pdfPaths.push(pdfPath);
    }

    if (pdfPaths.length > 0) {
      await sendEmailWithAttachments(
        'ChronoPilot - Monatliche Berichte',
        'Guten Tag Herr Sunay,\n\nanbei finden Sie die von uns verarbeiteten Berichte Ihrer Mitarbeiter.\nFalls es Unstimmigkeiten gibt, melden Sie sich bitte bei uns.\n\nMit freundlichen Grüßen,\nMilando Sunay von ChronoDuo',
        pdfPaths
      );
    }

    for (const filePath of pdfPaths) {
      await uploadPdfToBucket(filePath);
      fs.unlinkSync(filePath);
    }

    console.log('PDF-Workflow abgeschlossen!');
  } catch (error) {
    console.error('Fehler im Report-Workflow:', error.message);
    process.exit(1);
  }
}

runReportWorkflow();
