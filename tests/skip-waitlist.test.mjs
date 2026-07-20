import assert from 'node:assert/strict';
import test from 'node:test';

import handler, {
    getLondonWaitlistDateParts,
    normalizeSentMetafieldKey
} from '../pages/api/skip-waitlist.js';

const fixedNow = new Date('2026-07-19T12:34:00.000Z');

class FixedDate extends Date {
    constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
    }

    static now() {
        return fixedNow.getTime();
    }
}

test('next waitlist month follows the London date at the BST month boundary', () => {
    assert.deepEqual(
        getLondonWaitlistDateParts(new Date('2026-07-31T23:30:00.000Z')),
        {
            day: 1,
            month: 'August',
            currentYear: 2026,
            nextMonthName: 'September',
            nextYear: 2026
        }
    );
});

test('sent metafield keys accept the full theme key without appending twice', () => {
    assert.equal(normalizeSentMetafieldKey('evernight_waitlist'), 'evernight_waitlist_sent');
    assert.equal(normalizeSentMetafieldKey('evernight_waitlist_sent'), 'evernight_waitlist_sent');
});

const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body)
});

const createResponse = () => {
    const headers = new Map();

    return {
        headers,
        statusCode: null,
        body: null,
        setHeader(name, value) {
            headers.set(name.toLowerCase(), value);
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        end() {
            return this;
        }
    };
};

test('unknown origins are not granted browser CORS access', async () => {
    const res = createResponse();

    await handler(
        {
            method: 'OPTIONS',
            headers: { origin: 'https://attacker.example' },
            body: {}
        },
        res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.has('access-control-allow-origin'), false);
});

test('Skip writes the approved tag/state and preserves unrelated tags', async () => {
    const originalDate = globalThis.Date;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalEnv = {
        SHOPIFY_ADMIN_API_KEY: process.env.SHOPIFY_ADMIN_API_KEY,
        SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN
    };
    const requests = [];

    globalThis.Date = FixedDate;
    console.log = () => {};
    process.env.SHOPIFY_ADMIN_API_KEY = 'test-token';
    process.env.SHOPIFY_STORE_DOMAIN = 'example.myshopify.com';
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });

        if (String(url).endsWith('/metafields.json')) {
            return jsonResponse(200, { metafield: { id: 1 } });
        }

        if ((options.method || 'GET') === 'GET') {
            return jsonResponse(200, {
                customer: {
                    tags: [
                        'evernight-box',
                        'skipped:evernight-horror:1 May 2026 10:00 AM',
                        'Skipped:evernight-horror-June',
                        'waitlist:evernight-horror:19th July 2026:01:34 PM',
                        'unrelated-tag'
                    ].join(',')
                }
            });
        }

        return jsonResponse(200, { customer: { id: '123' } });
    };

    const req = {
        method: 'POST',
        headers: { origin: 'https://us.illumicrate.myshopify.com' },
        body: {
            customer_id: '123',
            subscription_key: 'evernight-horror',
            waitlist_tag: 'waitlist:evernight-horror:19th July 2026:01:34 PM',
            metafield_key: 'evernight_waitlist_sent'
        }
    };
    const res = createResponse();

    try {
        await handler(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.skipTag, 'Skipped:evernight-horror-July');
        assert.equal(
            res.headers.get('access-control-allow-origin'),
            'https://us.illumicrate.myshopify.com'
        );

        const metafieldBody = JSON.parse(requests[0].options.body);
        assert.deepEqual(metafieldBody.metafield, {
            namespace: 'klaviyo',
            key: 'evernight_waitlist_sent',
            value: 'false',
            type: 'boolean'
        });

        const customerUpdate = JSON.parse(requests.at(-1).options.body);
        const tags = customerUpdate.customer.tags.split(',');
        assert(tags.includes('Skipped:evernight-horror-July'));
        assert(tags.includes('waitlist:evernight-horror:19th August 2026:01:34 PM'));
        assert(tags.includes('evernight-box'));
        assert(tags.includes('unrelated-tag'));
        assert(!tags.some(tag => tag.startsWith('skipped:evernight-horror:')));
        assert(!tags.includes('Skipped:evernight-horror-June'));
        assert(!tags.includes('waitlist:evernight-horror:19th July 2026:01:34 PM'));
    } finally {
        globalThis.Date = originalDate;
        globalThis.fetch = originalFetch;
        console.log = originalLog;

        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
