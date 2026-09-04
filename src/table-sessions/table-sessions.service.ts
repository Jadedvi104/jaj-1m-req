import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CreateTableSessionDto } from './dto/create-table-session.dto';

@Injectable()
export class TableSessionsService {
  constructor(private readonly db: DatabaseService) {}

  async create(dto: CreateTableSessionDto) {
    const result = await this.db.query<{ id: string; expires_at: Date }>(
      `insert into table_sessions(branch_id, table_id)
       select t.branch_id, t.id from dining_tables t
       where t.branch_id=$1 and t.public_id=$2 and t.active
         and t.rotating_code_expires_at > now()
         and t.rotating_code_hash = encode(digest($3, 'sha256'), 'hex')
       returning id, expires_at`,
      [dto.branchId, dto.tablePublicId, dto.rotatingCode],
    );
    if (!result.rowCount)
      throw new BadRequestException('Invalid or expired table code');
    return {
      sessionId: result.rows[0].id,
      expiresAt: result.rows[0].expires_at,
    };
  }
}
