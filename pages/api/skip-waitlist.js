export default async function handler(req, res) {
    // Set proper response headers
    res.setHeader('Content-Type', 'application/json');
    
    const allowedOrigins = [
        'http://127.0.0.1:9292',
        'http://localhost:9292',
        'https://illumicrate-testing.myshopify.com'
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

    try {
        const {
            customer_id,
            subscription_key,
            waitlist_tag
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

        if (!SHOPIFY_ADMIN_API_KEY || !SHOPIFY_STORE_DOMAIN) {
            console.error('Missing Shopify environment variables');
            return res.status(500).json({ error: 'Server configuration error' });
        }
    
        // Step 1: Set metafield to false
        const metafieldResponse = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}/metafields.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
            },
            body: JSON.stringify({
                metafield: {
                    namespace: "klaviyo",
                    key: `waitlist_sent`,
                    value: "False",
                    type: "boolean"
                }
            })
        });

        if (!metafieldResponse.ok) {
            console.error('Failed to update metafield:', await metafieldResponse.text());
            return res.status(500).json({ error: 'Failed to update customer metafield' });
        }

        // Step 2: Extract the base tag and product handle
        console.log('Attempting to match base tag:', waitlist_tag);
        const tagParts = waitlist_tag.split(':');
        if (tagParts.length < 4) {
            console.log('Invalid tag format:', waitlist_tag);
            return res.status(400).json({ 
                error: 'Invalid waitlist tag format',
                received_tag: waitlist_tag
            });
        }
        
        const baseTag = tagParts[0].trim().replace(/waitlist$/, '');
        const productHandle = tagParts[2].trim();
        console.log('Extracted base tag:', baseTag);
        console.log('Extracted product handle:', productHandle);
        
        const now = new Date();
        const day = now.getDate();
        const month = now.toLocaleDateString('en-GB', { month: 'long' });
        const year = now.getFullYear();
        const time = now.toLocaleTimeString('en-GB', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false
        });
        const timestamp = `${day} ${month} ${year} ${time}`;
        const skipTag = `skipped:${baseTag.replace(/,/g, '')}:${productHandle} ${timestamp.replace(/,/g, '')}`;

        // Step 3: Fetch current tags
        const customerRes = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
            }
        });

        if (!customerRes.ok) {
            console.error('Failed to fetch customer:', await customerRes.text());
            return res.status(500).json({ error: 'Failed to fetch customer data' });
        }

        const customerData = await customerRes.json();
        const currentTags = customerData.customer.tags.split(',').map(t => t.trim());
        
        // Remove any existing skip tags for this product
        const productSkipPattern = new RegExp(`skipped:${baseTag.replace(/,/g, '')}:${productHandle}`);
        const filteredTags = currentTags.filter(tag => !productSkipPattern.test(tag));
        
        // Add the new skip tag
        filteredTags.push(skipTag);

        // Step 4: Update tags
        const updateResponse = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}.json`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
            },
            body: JSON.stringify({
                customer: {
                    id: customer_id,
                    tags: filteredTags.join(',')
                }
            })
        });

        if (!updateResponse.ok) {
            console.error('Failed to update customer tags:', await updateResponse.text());
            return res.status(500).json({ error: 'Failed to update customer tags' });
        }

        return res.status(200).json({ 
            success: true,
            skipTag: skipTag
        });
    } catch (err) {
        console.error('[Skip Waitlist Error]', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
  