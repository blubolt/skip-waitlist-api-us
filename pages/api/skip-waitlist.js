export default async function handler(req, res) {
    const allowedOrigins = [
        'http://127.0.0.1:9292', // for local dev
        'http://localhost:9292',
        'https://yourstore.com', // ← replace with your live Shopify store
        'https://yourstore.myshopify.com' // ← also add preview URLs if needed
      ];
    
      const origin = req.headers.origin;
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    
      // Preflight request
      if (req.method === 'OPTIONS') {
        return res.status(200).end();
      }
    
      // POST request only
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
      }
  
    const {
      customer_id,
      subscription_key, // e.g. "illumicrate", "afterlight"
      waitlist_tag      // full tag string to remove
    } = req.body;
  
    console.log('Received request body:', req.body);
  
    if (!customer_id || !subscription_key || !waitlist_tag) {
      console.log('Missing required fields:', {
        customer_id: !!customer_id,
        subscription_key: !!subscription_key,
        waitlist_tag: !!waitlist_tag
      });
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: {
          customer_id: !!customer_id,
          subscription_key: !!subscription_key,
          waitlist_tag: !!waitlist_tag
        }
      });
    }
  
    // Log the waitlist tag format for debugging
    console.log('Waitlist tag received:', waitlist_tag);
  
    const SHOPIFY_ADMIN_API_KEY = process.env.SHOPIFY_ADMIN_API_KEY;
    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
    const SHOPIFY_ADMIN_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2023-10`;
  
    try {
      // Step 1: Set metafield to false
      await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}/metafields.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
        },
        body: JSON.stringify({
          metafield: {
            namespace: "custom",
            key: `${subscription_key}_waitlist_sent`,
            value: "false",
            type: "boolean"
          }
        })
      });
  
      // Step 2: Extract date from waitlist_tag and create new skip tag
      console.log('Attempting to match date in waitlist tag:', waitlist_tag);
      const dateMatch = waitlist_tag.match(/:(\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4})$/);
      if (!dateMatch) {
        console.log('Failed to match date pattern in tag:', waitlist_tag);
        return res.status(400).json({ 
          error: 'Invalid waitlist tag format - could not extract date',
          received_tag: waitlist_tag,
          expected_format: 'waitlist:TAG:PRODUCT_HANDLE:DDth Month YYYY'
        });
      }
      
      const dateStr = dateMatch[1];
      console.log('Extracted date string:', dateStr);
      
      const monthMatch = dateStr.match(/(\w+)\s+\d{4}$/);
      if (!monthMatch) {
        console.log('Failed to extract month from date:', dateStr);
        return res.status(400).json({ 
          error: 'Invalid waitlist tag format - could not extract month',
          received_date: dateStr
        });
      }
      
      const monthSkipped = monthMatch[1].toLowerCase();
      const now = new Date();
      const timestamp = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) + ' ' + now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      const skipTag = `skip-${monthSkipped}-${timestamp}`;
  
      // Step 3: Fetch current tags
      const customerRes = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
        }
      });
  
      const customerData = await customerRes.json();
      const currentTags = customerData.customer.tags.split(',').map(t => t.trim());
      
      // Add the new skip tag if it doesn't already exist
      if (!currentTags.includes(skipTag)) {
        currentTags.push(skipTag);
      }
  
      // Step 4: Update tags
      await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
        },
        body: JSON.stringify({
          customer: {
            id: customer_id,
            tags: currentTags.join(', ')
          }
        })
      });
  
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('[Skip Waitlist Error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  