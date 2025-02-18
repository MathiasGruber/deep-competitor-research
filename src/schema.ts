import { z } from "zod";

/** Competitor information data to extract for the final competitor report */
export const schema = z.object({
    drug_name: z.string().describe("The name of the drug, e.g. Abrocitinib US/EU/JP, Barcitinib EU/JP, ADX 629, 611, etc."),
    api_name: z.string().describe("The API name of the drug, e.g. abrocitinib, barcitinib, ADX 629, 611, etc."),
    status: z.enum(['Active', 'Inactive', 'Recently inactive', 'Unspecified']).describe("The status of the drug"),
    description: z.array(z.object({
        text: z.string().describe("The event that occurred on the date, e.g. Ph2 study posted that was started 2021-10 and finished 2022-10. Study enrolled 24 participants. (NCT05641558)"),
        date: z.string().describe("The date of the information, e.g. 2024-01-01. If unknown, UNKNOWN."),
        source: z.string().describe("The URL of the source of the information")
    })).describe("Historic records of the drug"),
    drug_modality: z.enum(['Biologic', 'Cellular', 'Gene Therapy', 'Microbial', 'Small Molecule', 'Unspecified']).describe("The modality of the drug"),
    organization: z.string().describe("The organization that is developing the drug"),
    clinical_trial_phase: z.enum(['Approved / Marketed', 'Preclinical', 'Phase 1', 'Phase 2a', 'Phase 2b', 'Phase 3', 'Unspecified']).describe("The phase of the clinical trial"),
    route_of_administration: z.enum(['Oral', 'Injectable', 'Topical', 'Unspecified']).describe("The route of administration of the drug"),
    mode_of_action: z.string().describe("The mode of action of the drug, e.g. IL-4Ra, JAK1, OX4OL, etc."),
    references: z.array(z.string()).describe("References to the drug"),
});

export type DrugSchema = z.infer<typeof schema>; 