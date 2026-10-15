import { z } from 'zod/v4';

import { ROOT_SLUG, ROOT_SLUG_INPUT, SLUG_RE } from '../shared/slug.ts';

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
            tags: fields.tags.optional()
        }),
        update: z.strictObject({
            url: fields.url.optional(),
            slug: root.or(fields.slug).optional(),
            title: fields.title.optional(),
            redirectType: fields.redirectType.optional(),
            expiresAt: fields.expiresAt.optional(),
            archived: fields.archived.optional(),
            tags: fields.tags.optional()
        })
    };
}

export type LinkSchemas = ReturnType<typeof linkSchemas>;
export type CreateLinkInput = z.infer<LinkSchemas['create']>;
export type UpdateLinkInput = z.infer<LinkSchemas['update']>;
