import { Injectable } from '@nestjs/common';
import { CrudService } from '../common/crud.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService extends CrudService<
  User,
  CreateUserDto,
  UpdateUserDto
> {
  protected readonly entityName = 'User';
  protected build(id: number, dto: CreateUserDto): User {
    return { id, ...dto };
  }
}
