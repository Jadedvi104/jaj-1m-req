import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

/** Missing records return null; storage failures propagate to the caller. */
export abstract class UsersRepository {
  abstract findAll(): User[];
  abstract findById(id: number): User | null;
  abstract create(input: CreateUserDto): User;
  abstract update(id: number, changes: UpdateUserDto): User | null;
  abstract remove(id: number): User | null;
}
