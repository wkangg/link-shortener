import { z } from 'zod/v4';

import { ROOT_SLUG, ROOT_SLUG_INPUT, SLUG_RE } from '../shared/slug.ts';
import { WEBHOOK_SKIP_CATEGORIES } from '../shared/types.ts';

const tag = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[\w-]{1,32}$/, 'Tags are 1-32 letters, digits, `-` or `_`');

export function linkSchemas(shortHost: string) {
    const url = z
        .url({ protocol: /^https?$/, error: 'Enter a full http(s) URL' })
        .max(2048)
        .refine(value => !URL.canParse(value) || new URL(value).hostname !== shortHost, {
            error: 'A short link cannot point at the short domain itself'
        });

    const fields = {
        url,
        slug: z
            .string()
            .trim()
            .regex(SLUG_RE, 'Slugs are 1-64 letters, digits, `-` or `_`, or `/` for the root link'),
        title: z.string().trim().max(200).nullable(),
        redirectType: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]),
        expiresAt: z.number().int().positive().nullable(),
        archived: z.boolean(),
        trackDevice: z.boolean(),
        tags: z
            .array(tag)
            .max(20)
            .transform(tags => [...new Set(tags)])
    };

    // `/` means the root link (stored as an empty slug).
    const root = z.literal(ROOT_SLUG_INPUT).transform(() => ROOT_SLUG);

    return {
        create: z.strictObject({
            url: fields.url,
            // Empty or missing: a random slug.
            slug: root
                .or(fields.slug)
                .or(z.literal('').transform(() => null))
                .optional(),
            title: fields.title.optional(),
            redirectType: fields.redirectType.optional(),
            expiresAt: fields.expiresAt.optional(),
            trackDevice: fields.trackDevice.optional(),
            tags: fields.tags.optional()
        }),
        update: z.strictObject({
            url: fields.url.optional(),
            slug: root.or(fields.slug).optional(),
            title: fields.title.optional(),
            redirectType: fields.redirectType.optional(),
            expiresAt: fields.expiresAt.optional(),
            archived: fields.archived.optional(),
            trackDevice: fields.trackDevice.optional(),
            tags: fields.tags.optional()
        })
    };
}

export type LinkSchemas = ReturnType<typeof linkSchemas>;
export type CreateLinkInput = z.infer<LinkSchemas['create']>;
export type UpdateLinkInput = z.infer<LinkSchemas['update']>;

const webhookFields = {
    url: z.string().trim().min(1, 'Enter a URL').max(2048),
    kind: z.enum(['standard', 'discord']),
    description: z.string().trim().max(200).nullable(),
    enabled: z.boolean(),
    allLinks: z.boolean(),
    links: z
        .array(z.number().int().positive())
        .max(1000)
        .transform(ids => [...new Set(ids)]),
    tags: z
        .array(tag)
        .max(20)
        .transform(tags => [...new Set(tags)]),
    skip: z
        .array(z.enum(WEBHOOK_SKIP_CATEGORIES))
        .max(WEBHOOK_SKIP_CATEGORIES.length)
        .transform(skip => [...new Set(skip)]),
    includeIp: z.boolean()
};

export const webhookSchemas = {
    create: z.strictObject({
        url: webhookFields.url,
        // Missing: Discord when the URL is a Discord webhook, else standard.
        kind: webhookFields.kind.optional(),
        description: webhookFields.description.optional(),
        enabled: webhookFields.enabled.optional(),
        // Missing: every link, unless links or tags are given.
        allLinks: webhookFields.allLinks.optional(),
        links: webhookFields.links.optional(),
        tags: webhookFields.tags.optional(),
        skip: webhookFields.skip.optional(),
        includeIp: webhookFields.includeIp.optional()
    }),
    update: z.strictObject({
        url: webhookFields.url.optional(),
        description: webhookFields.description.optional(),
        enabled: webhookFields.enabled.optional(),
        allLinks: webhookFields.allLinks.optional(),
        links: webhookFields.links.optional(),
        tags: webhookFields.tags.optional(),
        skip: webhookFields.skip.optional(),
        includeIp: webhookFields.includeIp.optional()
    })
};

export type CreateWebhookInput = z.infer<typeof webhookSchemas.create>;
export type UpdateWebhookInput = z.infer<typeof webhookSchemas.update>;
