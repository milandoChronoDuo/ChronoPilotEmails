require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Umgebungsvariablen überprüfen
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);

// Supabase-Client initialisieren
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Datumsformatierung (mittels Intl)
function formatDate(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  
  const options = dateStr.includes("T")
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  
  return new Intl.DateTimeFormat('de-DE', options).format(date);
}

// Formatiert dynamische Tabellennamen (entfernt _MM_YYYY und wandelt in Title Case um)
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

// Fügt eine Kopfzeile mit Trennlinie ein (Report-Header, oben auf jeder Seite)
function addHeader(doc, tableName) {
  const displayName = formatTableName(tableName);
  const dateOptions = { month: 'long', year: 'numeric' };
  const headerText = `ChronoPilot Bericht - ${displayName} - ${new Date().toLocaleDateString('de-DE', dateOptions)}`;
  
  doc.font('Helvetica-Bold')
     .fontSize(14)
     .fillColor('#2c3e50')
     .text(headerText, { align: 'center' });
  
  // Horizontale Linie unter dem Header
  const lineY = doc.y + 5;
  doc.moveTo(doc.page.margins.left, lineY)
     .lineTo(doc.page.width - doc.page.margins.right, lineY)
     .strokeColor('#bdc3c7')
     .lineWidth(1)
     .stroke();
  doc.moveDown(1);
}

// Fügt eine Fußzeile mit Trennlinie ein
function drawFooter(doc, currentPage) {
  const footerY = doc.page.height - doc.page.margins.bottom - 40;
  // Horizontale Trennlinie über dem Footer
  doc.moveTo(doc.page.margins.left, footerY)
     .lineTo(doc.page.width - doc.page.margins.right, footerY)
     .strokeColor('#bdc3c7')
     .lineWidth(1)
     .stroke();
  
  doc.fontSize(10)
     .fillColor('#7f8c8d')
     .text(`Seite ${currentPage}`, doc.page.margins.left, footerY + 5, { 
       align: 'center', 
       width: doc.page.width - doc.page.margins.left - doc.page.margins.right 
     });
}

let currentPage = 1;

// Berechnet die optimalen Spaltenbreiten anhand von Header- und Inhaltsbreiten
function computeColumnWidths(doc, columns, data, tableWidth) {
  const padding = 20; // links+rechts
  let requiredWidths = [];
  doc.font('Helvetica-Bold').fontSize(12);
  columns.forEach(col => {
    let headerWidth = doc.widthOfString(col);
    let maxWidth = headerWidth;
    data.forEach(row => {
      const text = row[col] ? row[col].toString() : '';
      doc.font('Helvetica').fontSize(10);
      let cellWidth = doc.widthOfString(text);
      if (cellWidth > maxWidth) {
        maxWidth = cellWidth;
      }
    });
    requiredWidths.push(maxWidth + padding);
  });
  const totalRequired = requiredWidths.reduce((sum, w) => sum + w, 0);
  if (totalRequired < tableWidth) {
    const extra = tableWidth - totalRequired;
    const additional = extra / columns.length;
    return requiredWidths.map(w => w + additional);
  } else {
    const scale = tableWidth / totalRequired;
    return requiredWidths.map(w => w * scale);
  }
}

// Berechnet die benötigte Höhe für eine Zeile basierend auf den Zelleninhalten
function calculateRowMetrics(doc, columns, row) {
  let maxHeight = 20;
  const cellHeights = [];
  columns.forEach(col => {
    const text = row[col] ? row[col].toString() : '';
    const metrics = doc.fontSize(10).heightOfString(text, {
      width: 100, // Dummy – exakte Breite wird in computeColumnWidths bestimmt
      align: 'left'
    });
    cellHeights.push(metrics);
    maxHeight = Math.max(maxHeight, metrics);
  });
  return {
    rowHeight: maxHeight + 15,
    cellHeights
  };
}

// Zeichnet die Tabellenkopfzeile (Spaltennamen, Hintergrund, Rahmen)
// Diese Funktion wird auf jeder Seite (nach dem Report-Header) aufgerufen.
function drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths) {
  let y = doc.y;
  doc.rect(margin, y, tableWidth, headerHeight).fill('#3498db');
  doc.fillColor('white')
     .font('Helvetica-Bold')
     .fontSize(12);
  let cumX = margin;
  columns.forEach((col, i) => {
    doc.text(col, cumX + 5, y + 10, { width: columnWidths[i] - 10, align: 'left' });
    cumX += columnWidths[i];
  });
  // Rahmen (dick) um den Kopf
  doc.strokeColor('#bdc3c7').lineWidth(2);
  doc.rect(margin, y, tableWidth, headerHeight).stroke();
  cumX = margin;
  doc.lineWidth(1);
  for (let i = 1; i < columns.length; i++) {
    cumX += columnWidths[i - 1];
    doc.moveTo(cumX, y);
    doc.lineTo(cumX, y + headerHeight);
    doc.stroke();
  }
  y += headerHeight;
  doc.y = y;
}

// Zeichnet die gesamte Tabelle: Kopfzeile, Datenzeilen, Rahmen, Seitenumbruch inkl. Header & Footer
function drawTable(doc, tableName, data) {
  if (data.length === 0) {
    doc.fontSize(12).fillColor('red').text('Keine Daten verfügbar', { align: 'center' });
    return;
  }
  
  const margin = 50;
  const tableWidth = doc.page.width - margin * 2;
  const columns = Object.keys(data[0]);
  const columnWidths = computeColumnWidths(doc, columns, data, tableWidth);
  
  // Zeichne Tabellenkopfzeile
  doc.font('Helvetica-Bold').fontSize(12);
  const headerHeights = columns.map((col, i) => doc.heightOfString(col, { width: columnWidths[i] - 10 }));
  const headerHeight = Math.max(...headerHeights) + 20;
  drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths);
  
  const footerSpace = 50; // Platz für Footer
  let y = doc.y;
  
  // Datenzeilen
  data.forEach((row, rowIndex) => {
    const { rowHeight, cellHeights } = calculateRowMetrics(doc, columns, row);
    // Prüfe, ob noch genügend Platz für diese Zeile inkl. Footer vorhanden ist.
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - footerSpace) {
      drawFooter(doc, currentPage);
      doc.addPage({ margin: 50, size: 'A4' });
      currentPage++;
      // Auf neuer Seite: Header (Report-Header) und Tabellenkopf
      addHeader(doc, tableName);
      drawTableHeader(doc, margin, tableWidth, headerHeight, columns, columnWidths);
      y = doc.y;
    }
    
    // Hintergrund der Datenzeile (abwechselnd)
    doc.rect(margin, y, tableWidth, rowHeight).fill(rowIndex % 2 === 0 ? '#ecf0f1' : '#ffffff');
    
    // Zelleninhalt zeichnen, Datum formatieren
    let cumX = margin;
    doc.font('Helvetica').fontSize(10).fillColor('#2c3e50');
    columns.forEach((col, i) => {
      let value = row[col];
      if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
        value = formatDate(value);
      }
      doc.text(value ? value.toString() : '-', cumX + 5, y + 5, {
        width: columnWidths[i] - 10,
        align: 'left',
        ellipsis: true
      });
      cumX += columnWidths[i];
    });
    
    // Rahmen um die Datenzeile
    doc.strokeColor('#bdc3c7').lineWidth(1);
    doc.rect(margin, y, tableWidth, rowHeight).stroke();
    cumX = margin;
    for (let i = 1; i < columns.length; i++) {
      cumX += columnWidths[i - 1];
      doc.moveTo(cumX, y);
      doc.lineTo(cumX, y + rowHeight);
      doc.stroke();
    }
    
    y += rowHeight;
    doc.y = y;
  });
  
  // Auf der letzten Seite Footer zeichnen
  drawFooter(doc, currentPage);
}

// Ruft die Supabase RPC-Funktion "update_monthly_freizeitkonto" auf
async function updateMonthlyFreizeitkonto() {
  const { data, error } = await supabase.rpc('update_monthly_freizeitkonto');
  if (error) {
    console.error('Fehler beim Aufruf von update_monthly_freizeitkonto:', error);
  } else {
    console.log('Ergebnis von update_monthly_freizeitkonto:', data);
  }
}

// PDF-Generierung für eine Tabelle
async function generatePdfForTable(tableName, data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ 
      margin: 50,
      size: 'A4',
      bufferPages: true,
      font: 'Helvetica'
    });
    
    const filePath = path.join(__dirname, `${tableName}.pdf`);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    currentPage = 1;
    
    // Auf der ersten Seite den Report-Header einfügen
    addHeader(doc, tableName);
    // Zeichne dann die Tabellenkopfzeile und folge mit den Daten
    drawTable(doc, tableName, data);
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

// E-Mail-Versand (alle PDFs als Anhänge)
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

// Dateiupload in den Supabase-Bucket
async function uploadPdfToBucket(filePath) {
  try {
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    const { error } = await supabase.storage
      .from(process.env.BUCKET_NAME)
      .upload(fileName, fileData, {
        contentType: 'application/pdf',
        upsert: true
      });
    if (error) throw error;
    console.log(`Datei hochgeladen: ${fileName}`);
  } catch (error) {
    console.error(`Upload-Fehler: ${error.message}`);
    throw error;
  }
}

// Hauptworkflow: Statische und dynamische Tabellen verarbeiten, PDFs generieren, E-Mail versenden, Dateien hochladen & löschen
async function runWorkflow() {
  try {
    console.log('Starte Workflow...');
    const pdfPaths = [];
    
    // Statische Tabellen
    const staticTables = ['raw_data', 'gesamtzeiten', 'urlaubsantraege', 'daily_summary'];
    for (const table of staticTables) {
      console.log(`Verarbeite ${table}...`);
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        console.error(`Fehler bei ${table}:`, error.message);
        continue;
      }
      const pdfPath = await generatePdfForTable(table, data || []);
      pdfPaths.push(pdfPath);
    }
    
    // Dynamische Tabellen
    const { data: dynamicTables, error: tableError } = await supabase.rpc('get_dynamic_tables');
    if (tableError) throw tableError;
    
    const currentMonthYear = `${String(new Date().getMonth() + 1).padStart(2, '0')}_${new Date().getFullYear()}`;
    const relevantTables = dynamicTables.filter(t => t.table_name.endsWith(currentMonthYear));
    for (const table of relevantTables) {
      console.log(`Verarbeite ${table.table_name}...`);
      const { data, error } = await supabase.from(table.table_name).select('*');
      if (error) {
        console.error(`Fehler bei ${table.table_name}:`, error.message);
        continue;
      }
      const pdfPath = await generatePdfForTable(table.table_name, data || []);
      pdfPaths.push(pdfPath);
    }
    
    // E-Mail senden (alle PDFs als Anhänge)
    if (pdfPaths.length > 0) {
      await sendEmailWithAttachments(
        'ChronoPilot - Monatliche Berichte',
        'Guten Tag Herr Sunay,\n\nanbei finden Sie die von uns verarbeiteten Berichte Ihrer Mitarbeiter.\nfalls es Unstimmigkeiten gibt melden sie bitte bei uns.\n\nMit freundlichen Grüßen,\nMilando Sunay von ChronoDuo',
        pdfPaths
      );
    }
    
    // Dateien hochladen und lokal löschen
    for (const filePath of pdfPaths) {
      await uploadPdfToBucket(filePath);
      fs.unlinkSync(filePath);
      console.log(`Temporäre Datei gelöscht: ${filePath}`);
    }
    
    // Zum Schluss erst die Übertragung der Minusstunden (update_monthly_freizeitkonto) aufrufen
    await updateMonthlyFreizeitkonto();
    
    console.log('Workflow erfolgreich abgeschlossen!');
  } catch (error) {
    console.error('Kritischer Fehler:', error);
    process.exit(1);
  }
}

runWorkflow();
