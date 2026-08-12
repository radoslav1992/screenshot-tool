/**
 * The legal entity behind the service.
 *
 * One source of truth: the imprint on the terms and privacy pages, the footer
 * and anything sent to Stripe all read from here, so the company details cannot
 * say three different things.
 */
export const COMPANY = {
  /** As registered, in Latin script. */
  name: '"Digital Craft" Ltd.',
  /** As registered, in Cyrillic — the legally operative form in Bulgaria. */
  nameLocal: '„Дигитал Крафт“ ЕООД',
  /** Еднолично дружество с ограничена отговорност — single-member LLC. */
  form: 'Single-member limited liability company (ЕООД)',
  /** Unified Identification Code from the Bulgarian Commercial Register. */
  uic: '207583408',
  /**
   * Bulgarian VAT number, if registered. Leave null until it is — an unearned
   * VAT number on an invoice is worse than none.
   */
  vat: null as string | null,
  address: {
    street: 'bul. "Gotse Delchev" 43, floor 8, apt. 36',
    district: 'Krasno selo',
    city: 'Sofia',
    postcode: '1680',
    country: 'Bulgaria',
  },
  director: 'Radoslav Lazarov Dodnikov',
  email: 'hello@easyscreencapture.com',
  site: 'easyscreencapture.com',
  register: 'Commercial Register and Register of Non-Profit Legal Entities, Republic of Bulgaria',
  /** Where a Bulgarian data-subject complaint goes. */
  dpa: {
    name: 'Commission for Personal Data Protection (КЗЛД)',
    url: 'https://www.cpdp.bg',
  },
} as const;

export const COMPANY_ADDRESS_LINE = [
  COMPANY.address.street,
  COMPANY.address.district,
  `${COMPANY.address.postcode} ${COMPANY.address.city}`,
  COMPANY.address.country,
].join(', ');
