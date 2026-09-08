import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The process-local examples have no tenant or staff authorization model. */
@Injectable()
export class DemoOnlyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (
      this.config.get('NODE_ENV') !== 'development' ||
      this.config.get('ENABLE_DEMO_CRUD') !== 'true'
    ) {
      throw new NotFoundException();
    }
    return true;
  }
}
