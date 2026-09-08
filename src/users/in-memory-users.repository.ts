import { Injectable } from '@nestjs/common';
import { InMemoryRepository } from '../common/in-memory.repository';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';

/** Process-local adapter for flat records; not durable persistence. */
@Injectable()
export class InMemoryUsersRepository
  extends InMemoryRepository<User, CreateUserDto, UpdateUserDto>
  implements UsersRepository
{
  protected build(id: number, input: CreateUserDto): User {
    return { id, name: input.name, email: input.email };
  }

  override update(id: number, changes: UpdateUserDto): User | null {
    return super.update(id, { name: changes.name, email: changes.email });
  }
}
