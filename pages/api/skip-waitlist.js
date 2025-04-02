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
  
    if (!customer_id || !subscription_key || !waitlist_tag) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
  
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
  
      // Step 2: Fetch current tags
      const customerRes = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
        }
      });
  
      const customerData = await customerRes.json();
      const currentTags = customerData.customer.tags.split(',').map(t => t.trim());
      const updatedTags = currentTags.filter(tag => tag !== waitlist_tag);
  
      // Step 3: Update tags
      await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
        },
        body: JSON.stringify({
          customer: {
            id: customer_id,
            tags: updatedTags.join(', ')
          }
        })
      });
  
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('[Skip Waitlist Error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  