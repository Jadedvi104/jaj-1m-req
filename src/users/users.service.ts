import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}

  findAll(): User[] {
    return this.repository.findAll();
  }

  findOne(id: number): User {
    return this.requireUser(this.repository.findById(id), id);
  }

  create(input: CreateUserDto): User {
    return this.repository.create(input);
  }

  update(id: number, changes: UpdateUserDto): User {
    return this.requireUser(this.repository.update(id, changes), id);
  }

  remove(id: number): User {
    return this.requireUser(this.repository.remove(id), id);
  }

  private requireUser(record: User | null, id: number): User {
    if (record === null) {
      throw new NotFoundException(`User ${id} was not found`);
    }
    return record;
  }
}
