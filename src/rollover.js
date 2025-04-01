require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Supabase-Client initialisieren (wir verwenden hier den Service Key)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function callDataRollover() {
  // Wir übergeben ein leeres Objekt, da keine Parameter benötigt werden
  const { data, error } = await supabase.rpc('data_rollover', {});
  if (error) {
    console.error('Fehler beim Aufruf von data_rollover:', error);
    process.exit(1);
  } else {
    console.log('Response von data_rollover:', data);
  }
}

callDataRollover();
