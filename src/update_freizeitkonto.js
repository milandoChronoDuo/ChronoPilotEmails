require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function updateMonthlyFreizeitkonto() {
  const { data, error } = await supabase.rpc('update_monthly_freizeitkonto');
  if (error) {
    console.error('Fehler beim Aufruf von update_monthly_freizeitkonto:', error.message);
    process.exit(1);
  } else {
    console.log('Freizeitkonto erfolgreich aktualisiert:', data);
  }
}

updateMonthlyFreizeitkonto();
