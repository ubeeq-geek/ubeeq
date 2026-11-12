import {
  type TenancyAndAccessPort,
  type CreatorAccessRole,
  SingleOperatorLimitError,
  FeatureDisabledInSingleOperatorModeError
} from "@ubeeq/extension-sdk";

export interface SingleOperatorTenancyAdapterOptions {
  operatorUserId?: string | null;
  getOperatorUserId?: () => Promise<string | null> | string | null;
  setOperatorUserId?: (userId: string) => Promise<void> | void;
  countCreatorUsers?: () => Promise<number> | number;
  listOperatorCreatorIds?: (operatorUserId: string) => Promise<string[]> | string[];
}

export class SingleOperatorTenancyAdapter implements TenancyAndAccessPort {
  readonly mode = "single_operator" as const;
  private localOperatorUserId: string | null = null;
  private readonly options: SingleOperatorTenancyAdapterOptions;

  constructor(options?: SingleOperatorTenancyAdapterOptions) {
    this.options = options ?? {};
    this.localOperatorUserId = options?.operatorUserId ?? null;
  }

  async getOperatorUserId(): Promise<string | null> {
    if (this.options.operatorUserId) return this.options.operatorUserId;
    if (this.options.getOperatorUserId) return await this.options.getOperatorUserId();
    if (this.localOperatorUserId) return this.localOperatorUserId;
    return null;
  }

  async setOperatorUserId(userId: string): Promise<void> {
    if (!this.options.getOperatorUserId) this.localOperatorUserId = userId;
    if (this.options.setOperatorUserId) {
      await this.options.setOperatorUserId(userId);
    }
  }

  async assertCanCreateCreatorUser(context: {
    existingCreatorUserCount: number;
    actorUserId?: string;
  }): Promise<void> {
    const operatorId = await this.getOperatorUserId();

    // If an operator already exists and this request is for the same operator,
    // persona creation (multiple Creator Identities) is permitted.
    if (operatorId && context.actorUserId && context.actorUserId === operatorId) {
      return;
    }

    // If an operator already exists and a different user tries to create a creator, reject.
    if (operatorId && context.actorUserId && context.actorUserId !== operatorId) {
      throw new SingleOperatorLimitError();
    }

    // If no operator is recorded yet but the database already has >= 1 creator user, reject.
    if (context.existingCreatorUserCount >= 1) {
      throw new SingleOperatorLimitError();
    }

    // Initial operator registration: assign this actor as the instance operator.
    if (!operatorId && context.actorUserId) {
      await this.setOperatorUserId(context.actorUserId);
    }
  }

  async assertCanCreateCustomerAccount(_context?: { email?: string }): Promise<void> {
    // Unlimited buyer, subscriber, and client accounts are permitted.
  }

  async listAccessibleCreatorIds(actorUserId: string): Promise<string[]> {
    const operatorId = await this.getOperatorUserId();
    // Non-operator principals (including customer_account) have zero Studio creator access.
    if (!operatorId || operatorId !== actorUserId) {
      return [];
    }
    if (this.options.listOperatorCreatorIds) {
      const ids = await this.options.listOperatorCreatorIds(actorUserId);
      return [...ids];
    }
    return [];
  }

  async resolveCreatorRole(actorUserId: string, creatorId: string): Promise<CreatorAccessRole | null> {
    const accessible = await this.listAccessibleCreatorIds(actorUserId);
    return accessible.includes(creatorId) ? "owner" : null;
  }

  isContributorManagementEnabled(): boolean {
    return false;
  }

  isOrganizationManagementEnabled(): boolean {
    return false;
  }

  assertCanMutateContributors(): void {
    if (!this.isContributorManagementEnabled()) {
      throw new FeatureDisabledInSingleOperatorModeError("Contributor management");
    }
  }

  assertCanMutateOrganizations(): void {
    if (!this.isOrganizationManagementEnabled()) {
      throw new FeatureDisabledInSingleOperatorModeError("Organization management");
    }
  }
}

export const createSingleOperatorTenancyAdapter = (
  options?: SingleOperatorTenancyAdapterOptions
): SingleOperatorTenancyAdapter => new SingleOperatorTenancyAdapter(options);
