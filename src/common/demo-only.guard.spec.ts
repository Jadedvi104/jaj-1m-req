import { ConfigService } from '@nestjs/config';
import { DemoOnlyGuard } from './demo-only.guard';

describe('DemoOnlyGuard', () => {
  it.each([
    {},
    { NODE_ENV: 'production', ENABLE_DEMO_CRUD: 'true' },
    { NODE_ENV: 'test', ENABLE_DEMO_CRUD: 'true' },
    { NODE_ENV: 'development' },
  ])('fails closed for %p', (configuration) => {
    const config = new ConfigService({
      NODE_ENV: '',
      ENABLE_DEMO_CRUD: '',
      ...configuration,
    });
    expect(() => new DemoOnlyGuard(config).canActivate()).toThrow();
  });
  it('allows explicit development opt-in', () => {
    expect(
      new DemoOnlyGuard(
        new ConfigService({
          NODE_ENV: 'development',
          ENABLE_DEMO_CRUD: 'true',
        }),
      ).canActivate(),
    ).toBe(true);
  });
});
