import { z } from 'zod';

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  logo: z.string().url().optional(),
  website: z.string().url().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  fax: z.string().max(32).optional(),
  address: z.string().optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  pincode: z.string().max(10).optional(),
  latitude: z.string().max(40).optional(),
  longitude: z.string().max(40).optional(),
  pan: z.string().max(30).optional(),
  tan: z.string().max(30).optional(),
  cin: z.string().max(30).optional(),
  gstin: z.string().max(30).optional(),
  udyamRegistrationNumber: z.string().max(30).optional(),
  establishedAt: z
    .union([z.string().datetime({ message: 'Invalid date format for establishedAt' }), z.date()])
    .optional()
    .transform((val) => (val ? new Date(val).toISOString() : undefined)),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
