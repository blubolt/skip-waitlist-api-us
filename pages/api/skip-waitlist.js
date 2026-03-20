export default async function handler(req, res) {
    // Set proper response headers
    res.setHeader('Content-Type', 'application/json');
    
    const allowedOrigins = [
        'http://127.0.0.1:9292',
        'http://localhost:9292',
        'https://illumicrate-testing.myshopify.com',
        'https://illumicrate.myshopify.com',
        'https://us.illumicrate.myshopify.com'
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
            waitlist_tag,
            metafield_key,
            is_remove = false,
            customer_tag_to_remove,
            customer_email,
            klaviyo_id
        } = req.body;

        console.log('Received request body:', req.body);

        if (!customer_id || !subscription_key || !waitlist_tag || !metafield_key) {
            console.log('Missing required fields:', {
                customer_id: !!customer_id,
                subscription_key: !!subscription_key,
                waitlist_tag: !!waitlist_tag,
                metafield_key: !!metafield_key
            });
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: {
                    customer_id: !!customer_id,
                    subscription_key: !!subscription_key,
                    waitlist_tag: !!waitlist_tag,
                    metafield_key: !!metafield_key
                }
            });
        }

        // Log the waitlist tag format for debugging
        console.log('Waitlist tag received:', waitlist_tag);

        const SHOPIFY_ADMIN_API_KEY = process.env.SHOPIFY_ADMIN_API_KEY;
        const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
        const SHOPIFY_ADMIN_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2023-10`;
        const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

        if (!SHOPIFY_ADMIN_API_KEY || !SHOPIFY_STORE_DOMAIN) {
            console.error('Missing Shopify environment variables');
            return res.status(500).json({ error: 'Server configuration error' });
        }
    
        // Step 1: Set metafield to false
        const metafieldKey = `${metafield_key}_sent`;
        console.log('Setting metafield:', `klaviyo.${metafieldKey} to false`);
        console.log('Customer ID:', customer_id);
        console.log('Shopify API URL:', `${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}/metafields.json`);
        
        const metafieldPayload = {
            metafield: {
                namespace: "klaviyo",
                key: metafieldKey,
                value: "false",
                type: "boolean"
            }
        };
        
        console.log('Metafield payload:', JSON.stringify(metafieldPayload, null, 2));
        
        const metafieldResponse = await fetch(`${SHOPIFY_ADMIN_API_URL}/customers/${customer_id}/metafields.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
            },
            body: JSON.stringify(metafieldPayload)
        });

        console.log('Metafield response status:', metafieldResponse.status);
        console.log('Metafield response headers:', Object.fromEntries(metafieldResponse.headers.entries()));

        if (!metafieldResponse.ok) {
            const errorText = await metafieldResponse.text();
            console.error('Failed to update metafield. Status:', metafieldResponse.status);
            console.error('Error response:', errorText);
            return res.status(500).json({ 
                error: 'Failed to update customer metafield',
                details: {
                    status: metafieldResponse.status,
                    response: errorText
                }
            });
        }

        const metafieldResult = await metafieldResponse.json();
        console.log('Metafield update successful:', metafieldResult);

        // Step 2: Use the subscription_key as the product handle
        console.log('Using subscription_key as product handle:', subscription_key);
        const productHandle = subscription_key;
        console.log('Product handle:', productHandle);
        
        // Use BST timezone to match user expectations
        const now = new Date();
        
        // Get date components in BST timezone
        const day = now.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'Europe/London' });
        const month = now.toLocaleDateString('en-GB', { month: 'long', timeZone: 'Europe/London' });
        const year = now.toLocaleDateString('en-GB', { year: 'numeric', timeZone: 'Europe/London' });
        const time = now.toLocaleTimeString('en-GB', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true,
            timeZone: 'Europe/London'
        });
        const timestamp = `${day} ${month} ${year} ${time}`;
        const skipTag = `skipped:${productHandle}:${timestamp.replace(/,/g, '')}`;

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
        const productSkipPattern = new RegExp(`skipped:${productHandle}:`);
        let filteredTags = currentTags.filter(tag => !productSkipPattern.test(tag));

        if (!is_remove) {
            // Add the new skip tag
            filteredTags.push(skipTag);
        } else {
            const removeTagPattern = new RegExp(`waitlist:${productHandle}:`);
            // Also remove the waitlist tag for this month if is_remove is true
            filteredTags = filteredTags.filter(tag => !removeTagPattern.test(tag));
            filteredTags = filteredTags.filter(tag => tag != customer_tag_to_remove);

            // Remove customer from Klaviyo list
            if (klaviyo_id && customer_email) {
                try {
                    console.log('Removing customer from Klaviyo list:', klaviyo_id);
                    
                    // Step 1: Get the profile ID from Klaviyo using email
                    const encodedEmail = encodeURIComponent(customer_email);
                    const getProfileUrl = `https://a.klaviyo.com/api/lists/${klaviyo_id}/relationships/profiles?filter=equals(email,'${encodedEmail}')&page[size]=20`;
                    
                    const getProfileResponse = await fetch(getProfileUrl, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
                            'accept': 'application/vnd.api+json',
                            'revision': '2025-10-15'
                        }
                    });

                    if (!getProfileResponse.ok) {
                        const errorText = await getProfileResponse.text();
                        console.error('Failed to get Klaviyo profile. Status:', getProfileResponse.status);
                        console.error('Error response:', errorText);
                    } else {
                        const profileData = await getProfileResponse.json();
                        console.log('Klaviyo profile data:', profileData);

                        // Check if we found a profile
                        if (profileData.data && profileData.data.length > 0) {
                            const profileId = profileData.data[0].id;
                            console.log('Found Klaviyo profile ID:', profileId);

                            // Step 2: Remove the profile from the list
                            const removeProfileUrl = `https://a.klaviyo.com/api/lists/${klaviyo_id}/relationships/profiles`;
                            const removePayload = {
                                data: [
                                    {
                                        type: "profile",
                                        id: profileId
                                    }
                                ]
                            };

                            const removeProfileResponse = await fetch(removeProfileUrl, {
                                method: 'DELETE',
                                headers: {
                                    'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
                                    'accept': 'application/vnd.api+json',
                                    'content-type': 'application/vnd.api+json',
                                    'revision': '2025-10-15'
                                },
                                body: JSON.stringify(removePayload)
                            });

                            if (!removeProfileResponse.ok) {
                                const errorText = await removeProfileResponse.text();
                                console.error('Failed to remove profile from Klaviyo list. Status:', removeProfileResponse.status);
                                console.error('Error response:', errorText);
                            } else {
                                console.log('Successfully removed profile from Klaviyo list');
                            }
                        } else {
                            console.log('No profile found in Klaviyo list for email:', customer_email);
                        }
                    }
                } catch (klaviyoError) {
                    console.error('Error processing Klaviyo removal:', klaviyoError);
                    // Don't fail the entire request if Klaviyo removal fails
                }
            } else {
                console.log('Skipping Klaviyo removal: missing klaviyo_id or customer_email');
            }
        }

        if (!is_remove) {
            // Step 4: Create new waitlist tag for next month
            const currentMonth = now.getMonth(); // 0-11
            const currentYear = now.getFullYear();

            // Calculate next month
            let nextMonth = currentMonth + 1;
            let nextYear = currentYear;
            if (nextMonth > 11) {
                nextMonth = 0;
                nextYear++;
            }

            // Create date for next month
            const nextMonthDate = new Date(nextYear, nextMonth, 1);
            const nextMonthName = nextMonthDate.toLocaleDateString('en-GB', { month: 'long', timeZone: 'Europe/London' });

            // Create the new waitlist tag for next month
            const nextMonthWaitlistTag = `waitlist:${productHandle}:${day} ${nextMonthName.toLowerCase()}-${nextYear}:${time}`;

            // Add the new waitlist tag if it doesn't already exist
            if (!filteredTags.includes(nextMonthWaitlistTag)) {
                filteredTags.push(nextMonthWaitlistTag);
                console.log('Added new waitlist tag for next month:', nextMonthWaitlistTag);
            }
        }

        console.log('Final tags to be set:', filteredTags);

        // Step 5: Update tags
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
};
