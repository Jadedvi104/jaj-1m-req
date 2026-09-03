export interface OrderView {
  id: string;
  publicReference: string;
  displayNumber: string;
  status: string;
  totalSatang: number;
  currency: 'THB';
  reservationExpiresAt: Date;
  extensionUsed: boolean;
  paymentReference?: string;
}
