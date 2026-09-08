import { InMemoryUsersRepository } from './in-memory-users.repository';
import { UsersRepository } from './users.repository';
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: UsersRepository, useClass: InMemoryUsersRepository },
  ],
  exports: [UsersService],
})
export class UsersModule {}
