/** SDK command transport supplied by a trusted host. Keep SDK-version-specific
 * middleware types inside the adapter rather than leaking them across package boundaries.
 * Command inputs and parsed service results remain typed at their use sites.
 */
export interface AwsCommandClient { send(command: any): Promise<any>; }
